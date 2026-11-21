// Voice chat for online tables: everyone at the table who has joined voice can hear everyone else.
//
// The sound goes directly from browser to browser (WebRTC), one connection per pair of players, so
// at most 3 connections each at a 4-player table. The game server only passes along the short setup
// messages ('signal') that let two browsers find each other; it never hears anything.
//
// In each pair the player in the lower seat makes the call and the other answers, so the two never
// call each other at the same moment. Every call attempt has its own random id ('s' in the setup
// messages, and 'r' for the id being answered), so leftovers from an earlier attempt, or from before
// someone reloaded the page, are recognised and ignored. If a call has not connected after a few
// seconds, or drops, the caller simply starts a fresh one.

import type { ClientMsg, RoomInfo, SignalData } from '../shared/protocol.js';

export type VoiceState = 'off' | 'starting' | 'on' | 'muted' | 'blocked';

const FALLBACK_ICE: RTCIceServer[] = [{ urls: ['stun:stun.cloudflare.com:3478', 'stun:stun.l.google.com:19302'] }];
/** How loud (0..1 RMS) counts as talking, for the little "speaking" glow. */
const SPEAKING_LEVEL = 0.02;
/** A call that has not connected after this long is tried again from scratch. */
const REDIAL_MS = 12_000;

interface Peer {
  seat: number;
  pc: RTCPeerConnection;
  /** True if we make the call (we sit in the lower seat). */
  caller: boolean;
  /** This call attempt's id, and the other side's (once known). */
  id: string;
  remoteId: string | null;
  createdAt: number;
  audio: HTMLAudioElement;
  meter: Meter | null;
  /** Setup messages are handled one at a time, in order. */
  queue: Promise<void>;
}

interface Meter {
  analyser: AnalyserNode;
  source: MediaStreamAudioSourceNode;
  data: Uint8Array<ArrayBuffer>;
}

export function voiceSupported(): boolean {
  return typeof RTCPeerConnection !== 'undefined' && !!navigator.mediaDevices?.getUserMedia;
}

export class Voice {
  state: VoiceState = 'off';
  /** The browser would not start the others' sound without a tap (autoplay rules). Any tap fixes it. */
  needsTap = false;
  /** Seats talking right now (including your own while you speak). */
  speaking = new Set<number>();

  private stream: MediaStream | null = null;
  private iceServers: RTCIceServer[] | null = null;
  private peers = new Map<number, Peer>();
  private you = -1;
  private room: RoomInfo | null = null;
  private ctx: AudioContext | null = null;
  private localMeter: Meter | null = null;
  private meterTimer: number | undefined;
  private callTimer: number | undefined;
  private attempts = 0;
  private stuckTimer: number | undefined;
  /** Still waiting for the microphone after a few seconds: probably needs a tap to ask. */
  stuck = false;
  private host: HTMLElement;
  private closed = false;
  private unlock = () => this.retryPlayback();
  /** Recent call-setup events, for the browser tests and for debugging. */
  readonly log: string[] = [];
  private note(text: string): void {
    this.log.push(`${Math.round(performance.now())} ${text}`);
    if (this.log.length > 200) this.log.shift();
  }

  constructor(
    private send: (msg: ClientMsg) => void,
    private onChange: () => void,
    private onSpeaking: (speaking: ReadonlySet<number>) => void = () => {},
  ) {
    this.host = document.createElement('div');
    this.host.hidden = true;
    this.host.id = 'voice-audio';
    document.body.append(this.host);
    document.addEventListener('pointerdown', this.unlock, true);
    document.addEventListener('keydown', this.unlock, true);
  }

  get active(): boolean {
    return this.state === 'on' || this.state === 'muted';
  }

  /** Turn the microphone on and join the table's voice chat. Asks for microphone permission the first time. */
  async start(again = false): Promise<void> {
    if (this.closed || this.active || (this.state === 'starting' && !again)) return;
    if (!voiceSupported()) {
      this.setState('blocked');
      return;
    }
    // Some browsers (headsets in particular) only show the microphone question after a tap on the page.
    // If nothing has happened after a few seconds, the button says "Tap to turn on voice" and a tap
    // asks again, this time from the tap itself.
    const attempt = ++this.attempts;
    this.stuck = false;
    window.clearTimeout(this.stuckTimer);
    this.stuckTimer = window.setTimeout(() => {
      if (this.state === 'starting' && attempt === this.attempts) {
        this.stuck = true;
        this.onChange();
      }
    }, 4000);
    this.setState('starting');
    try {
      const [stream, ice] = await Promise.all([
        navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true }, video: false }),
        this.iceServers ? Promise.resolve(this.iceServers) : fetchIceServers(),
      ]);
      if (this.closed || this.active) {
        // Left the table meanwhile, or an earlier attempt got there first.
        stream.getTracks().forEach((t) => t.stop());
        return;
      }
      this.stuck = false;
      window.clearTimeout(this.stuckTimer);
      this.stream = stream;
      this.iceServers = ice;
      this.startMeters();
      this.localMeter = this.meter(stream);
      this.setState('on');
      this.send({ t: 'voice', on: true });
      this.sync();
      this.callTimer = window.setInterval(() => this.checkCalls(), 2000);
    } catch (e) {
      console.warn('Voice chat could not start', e);
      if (!this.closed && !this.active && attempt === this.attempts) {
        this.stuck = false;
        window.clearTimeout(this.stuckTimer);
        this.setState('blocked');
      }
    }
  }

  /** Mute or unmute your microphone. You keep hearing the others. */
  toggleMute(): void {
    if (!this.stream) return;
    const muted = this.state !== 'muted';
    this.stream.getAudioTracks().forEach((t) => (t.enabled = !muted));
    this.setState(muted ? 'muted' : 'on');
  }

  /** After (re)connecting to the table: tell the server again that we are in voice. */
  rejoined(): void {
    if (this.active) this.send({ t: 'voice', on: true });
  }

  /** Every room update: call the players who are in voice, hang up on the ones who left. */
  update(you: number, room: RoomInfo): void {
    this.you = you;
    this.room = room;
    this.sync();
  }

  handleSignal(from: number, data: SignalData): void {
    if (!this.stream || from === this.you) return;
    let peer = this.peers.get(from);
    if (from > this.you) {
      // We are the caller: only answers to our current attempt count.
      if (!peer || data.r !== peer.id) return;
      if (!peer.remoteId) peer.remoteId = data.s;
      if (peer.remoteId !== data.s) return;
    } else {
      // We answer. A new offer (new id) means the caller started afresh: drop the old attempt.
      const isOffer = 'sdp' in data && data.sdp.type === 'offer';
      if (peer && peer.remoteId !== data.s) {
        if (!isOffer) return;
        this.closePeer(from);
        peer = undefined;
      }
      if (!peer) {
        if (!isOffer) return;
        peer = this.createPeer(from);
        peer.remoteId = data.s;
      }
    }
    const p = peer;
    p.queue = p.queue.then(() => this.applySignal(p, data)).catch((e) => {
      this.note(`setup failed ${e}`);
      console.warn('Voice setup message failed', e);
    });
  }

  /** Leave voice chat and tidy up everything (leaving the table). */
  close(): void {
    this.closed = true;
    for (const seat of [...this.peers.keys()]) this.closePeer(seat);
    this.stream?.getTracks().forEach((t) => t.stop());
    this.stream = null;
    window.clearInterval(this.meterTimer);
    window.clearInterval(this.callTimer);
    window.clearTimeout(this.stuckTimer);
    void this.ctx?.close().catch(() => {});
    this.ctx = null;
    this.host.remove();
    document.removeEventListener('pointerdown', this.unlock, true);
    document.removeEventListener('keydown', this.unlock, true);
  }

  // ---------------------------------------------------------------- calls

  private sync(): void {
    if (!this.stream || !this.room) return;
    this.room.seats.forEach((s, seat) => {
      const wanted = seat !== this.you && !!s?.connected && !!s.voice;
      if (wanted && !this.peers.has(seat) && seat > this.you) this.call(seat);
      if (!wanted && this.peers.has(seat)) this.closePeer(seat);
    });
  }

  /** Start a fresh call to a player in a higher seat. */
  private call(seat: number): void {
    const p = this.createPeer(seat);
    p.queue = p.queue
      .then(async () => {
        await p.pc.setLocalDescription(await p.pc.createOffer());
        this.sendSdp(p);
      })
      .catch((e) => this.note(`offer failed ${e}`));
  }

  private createPeer(seat: number): Peer {
    const pc = new RTCPeerConnection({ iceServers: this.iceServers ?? FALLBACK_ICE });
    const audio = document.createElement('audio');
    audio.autoplay = true;
    audio.setAttribute('playsinline', '');
    audio.dataset.seat = String(seat);
    this.host.append(audio);
    const peer: Peer = {
      seat,
      pc,
      caller: seat > this.you,
      id: Math.random().toString(36).slice(2, 12),
      remoteId: null,
      createdAt: Date.now(),
      audio,
      meter: null,
      queue: Promise.resolve(),
    };
    this.peers.set(seat, peer);
    this.note(`peer ${seat} created caller=${peer.caller}`);

    pc.onicecandidate = ({ candidate }) => {
      if (candidate && candidate.candidate) {
        this.signal(peer, { ice: { candidate: candidate.candidate, sdpMid: candidate.sdpMid, sdpMLineIndex: candidate.sdpMLineIndex } });
      }
    };
    pc.ontrack = ({ track, streams }) => {
      const remote = streams[0] ?? new MediaStream([track]);
      if (audio.srcObject !== remote) {
        audio.srcObject = remote;
        peer.meter?.source.disconnect();
        peer.meter = this.meter(remote);
      }
      this.play(audio);
    };
    pc.onconnectionstatechange = () => {
      this.note(`peer ${seat} ${pc.connectionState}`);
      if (pc.connectionState === 'failed' && peer.caller && this.peers.get(seat) === peer) this.redial(seat);
      this.onChange();
    };
    for (const track of this.stream!.getTracks()) pc.addTrack(track, this.stream!);
    return peer;
  }

  private signal(p: Peer, data: { sdp: { type: 'offer' | 'answer'; sdp: string } } | { ice: { candidate: string; sdpMid: string | null; sdpMLineIndex: number | null } }): void {
    const full = { s: p.id, ...(p.remoteId ? { r: p.remoteId } : {}), ...data } as SignalData;
    this.note(`send ${p.seat} ${'sdp' in data ? data.sdp.type : 'ice'}`);
    this.send({ t: 'signal', to: p.seat, data: full });
  }

  private sendSdp(p: Peer): void {
    const d = p.pc.localDescription;
    if (d && (d.type === 'offer' || d.type === 'answer')) this.signal(p, { sdp: { type: d.type, sdp: d.sdp } });
  }

  private async applySignal(p: Peer, data: SignalData): Promise<void> {
    this.note(`recv ${p.seat} ${'sdp' in data ? data.sdp.type : 'ice'} state=${p.pc.signalingState}`);
    if (this.peers.get(p.seat) !== p) return; // hung up meanwhile
    const pc = p.pc;
    if ('sdp' in data) {
      await pc.setRemoteDescription(data.sdp);
      if (data.sdp.type === 'offer') {
        await pc.setLocalDescription(await pc.createAnswer());
        this.sendSdp(p);
      }
    } else if (data.ice) {
      await pc.addIceCandidate(data.ice);
    }
  }

  /** Hang up and call again (the caller's side only). */
  private redial(seat: number): void {
    this.note(`redial ${seat}`);
    this.closePeer(seat);
    this.sync();
  }

  /** Calls that have not connected after a while are started again. */
  private checkCalls(): void {
    const now = Date.now();
    for (const p of [...this.peers.values()]) {
      if (p.caller && p.pc.connectionState !== 'connected' && now - p.createdAt > REDIAL_MS) this.redial(p.seat);
    }
  }

  private closePeer(seat: number): void {
    const p = this.peers.get(seat);
    if (!p) return;
    this.note(`peer ${seat} closed`);
    this.peers.delete(seat);
    p.pc.close();
    p.meter?.source.disconnect();
    p.audio.srcObject = null;
    p.audio.remove();
    if (this.speaking.delete(seat)) this.onSpeaking(this.speaking);
  }

  // ---------------------------------------------------------------- sound out

  private play(audio: HTMLAudioElement): void {
    audio.play().then(
      () => {
        if (this.needsTap && [...this.peers.values()].every((p) => !p.audio.paused || !p.audio.srcObject)) {
          this.needsTap = false;
          this.onChange();
        }
      },
      () => {
        if (!this.needsTap) {
          this.needsTap = true;
          this.onChange();
        }
      },
    );
  }

  private retryPlayback(): void {
    void this.ctx?.resume().catch(() => {});
    for (const p of this.peers.values()) if (p.audio.srcObject && p.audio.paused) this.play(p.audio);
    if (this.needsTap && [...this.peers.values()].every((p) => !p.audio.paused || !p.audio.srcObject)) {
      this.needsTap = false;
      this.onChange();
    }
  }

  // ---------------------------------------------------------------- who is talking

  private startMeters(): void {
    try {
      this.ctx = new AudioContext();
    } catch {
      return; // no meters, voice still works
    }
    this.meterTimer = window.setInterval(() => this.measure(), 150);
  }

  private meter(stream: MediaStream): Meter | null {
    if (!this.ctx) return null;
    try {
      const source = this.ctx.createMediaStreamSource(stream);
      const analyser = this.ctx.createAnalyser();
      analyser.fftSize = 512;
      source.connect(analyser); // not connected to the speakers: the <audio> element plays the sound
      return { source, analyser, data: new Uint8Array(analyser.fftSize) };
    } catch {
      return null;
    }
  }

  private measure(): void {
    const now = new Set<number>();
    const loud = (m: Meter | null) => {
      if (!m) return false;
      m.analyser.getByteTimeDomainData(m.data);
      let sum = 0;
      for (const v of m.data) sum += ((v - 128) / 128) ** 2;
      return Math.sqrt(sum / m.data.length) > SPEAKING_LEVEL;
    };
    if (this.state === 'on' && loud(this.localMeter)) now.add(this.you);
    for (const p of this.peers.values()) if (loud(p.meter)) now.add(p.seat);
    if (now.size === this.speaking.size && [...now].every((s) => this.speaking.has(s))) return;
    this.speaking = now;
    this.onSpeaking(now);
  }

  private setState(s: VoiceState): void {
    this.state = s;
    this.onChange();
  }

  /** For the browser tests: how each call is doing. */
  debug(): { state: VoiceState; peers: { seat: number; connection: string; playing: boolean; signaling: string; ice: string; caller: boolean }[] } {
    return {
      state: this.state,
      peers: [...this.peers.values()].map((p) => ({
        seat: p.seat,
        connection: p.pc.connectionState,
        playing: !!p.audio.srcObject && !p.audio.paused,
        signaling: p.pc.signalingState,
        ice: p.pc.iceConnectionState,
        caller: p.caller,
      })),
    };
  }
}

async function fetchIceServers(): Promise<RTCIceServer[]> {
  try {
    const res = await fetch('/api/ice');
    if (!res.ok) return FALLBACK_ICE;
    const body = (await res.json()) as { iceServers?: RTCIceServer[] };
    return Array.isArray(body.iceServers) && body.iceServers.length ? body.iceServers : FALLBACK_ICE;
  } catch {
    return FALLBACK_ICE;
  }
}
