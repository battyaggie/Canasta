// Ready-made people for the 3D table (Quaternius, CC0: see web/avatars/README.md), posed in code.
// The models stand in a T-pose; every frame we put them back to that pose and bend the bones so they
// sit on their chair with their hands at the table, lean in on their turn and reach for the stock or pile.
import * as THREE from 'three';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { clone as cloneSkinned } from 'three/addons/utils/SkeletonUtils.js';

export type Build = 'man' | 'woman';

const cache = new Map<Build, Promise<THREE.Object3D>>();

function load(build: Build): Promise<THREE.Object3D> {
  let p = cache.get(build);
  if (!p) {
    p = new GLTFLoader().loadAsync(`/avatars/${build}.glb`).then((g) => g.scene);
    // A failed load (offline, say) may be retried next time.
    p.catch(() => cache.delete(build));
    cache.set(build, p);
  }
  return p;
}

export interface Look {
  build: Build;
  /** Multiplies the light skin texture. */
  skin: number;
  hair: number;
  /** Multiplies the outfit texture, so each seat wears a different colour. */
  outfit: number;
}

const X = new THREE.Vector3(1, 0, 0);
const Y = new THREE.Vector3(0, 1, 0);

/** One seated person. Positions are in the seat's own space: the chair at the origin, facing +z (the table). */
export class Person {
  readonly root = new THREE.Group();
  private bones = new Map<string, THREE.Bone>();
  private rest = new Map<THREE.Bone, THREE.Quaternion>();
  private ankleY = 0.08;

  constructor(model: THREE.Object3D, look: Look) {
    this.root.add(model);
    model.traverse((o) => {
      const bone = o as THREE.Bone;
      if (bone.isBone) {
        this.bones.set(bone.name, bone);
        this.rest.set(bone, bone.quaternion.clone());
      }
      const mesh = o as THREE.SkinnedMesh;
      if (mesh.isMesh) {
        // Bounds come from the standing pose, so don't let three.js cull a seated person by mistake.
        mesh.frustumCulled = false;
        mesh.userData.avatarPart = true;
        const mat = (mesh.material as THREE.MeshStandardMaterial).clone();
        if (/Hair/.test(mat.name)) mat.color.setHex(look.hair);
        else if (/Regular/.test(mat.name)) mat.color.setHex(look.skin);
        else if (/Peasant/.test(mat.name)) mat.color.setHex(look.outfit);
        mesh.material = mat;
      }
    });
    // Sit down: hips just above the seat (0.47 m), a little back from the table.
    this.root.updateMatrixWorld(true);
    const hip = this.world('thigh_l');
    this.ankleY = this.world('foot_l').y;
    model.position.set(0, 0.55 - hip.y, -0.1);
    this.root.updateMatrixWorld(true);
  }

  static async create(look: Look): Promise<Person> {
    return new Person(cloneSkinned(await load(look.build)), look);
  }

  private bone(name: string): THREE.Bone {
    const b = this.bones.get(name);
    if (!b) throw new Error(`no bone ${name}`);
    return b;
  }

  private world(name: string): THREE.Vector3 {
    return this.bone(name).getWorldPosition(new THREE.Vector3());
  }

  /** Rotate a bone by a rotation given in the seat's space. */
  private turn(name: string, axis: THREE.Vector3, angle: number): void {
    const seat = this.root.getWorldQuaternion(new THREE.Quaternion());
    const q = new THREE.Quaternion().setFromAxisAngle(axis.clone().applyQuaternion(seat), angle);
    this.rotateWorld(this.bone(name), q);
  }

  private rotateWorld(bone: THREE.Bone, q: THREE.Quaternion): void {
    const parent = bone.parent!.getWorldQuaternion(new THREE.Quaternion());
    bone.quaternion.premultiply(parent.clone().invert().multiply(q).multiply(parent));
    bone.updateMatrixWorld(true);
  }

  /** Turn a bone so that the joint `child` lies in direction `dir` (world space) from it. */
  private aim(name: string, child: string, dir: THREE.Vector3): void {
    const from = this.world(name);
    const now = this.world(child).sub(from).normalize();
    this.rotateWorld(this.bone(name), new THREE.Quaternion().setFromUnitVectors(now, dir.clone().normalize()));
  }

  /** Two bones (thigh and calf, or upper arm and forearm) reaching for a point, the bend towards `pole`. All in world space. */
  private reach(upper: string, lower: string, end: string, target: THREE.Vector3, pole: THREE.Vector3): void {
    const s = this.world(upper);
    const la = s.distanceTo(this.world(lower));
    const lb = this.world(lower).distanceTo(this.world(end));
    const toT = target.clone().sub(s);
    const d = Math.min(Math.max(toT.length(), Math.abs(la - lb) + 0.001), (la + lb) * 0.999);
    const n = toT.normalize();
    const along = (la * la - lb * lb + d * d) / (2 * d);
    const h = Math.sqrt(Math.max(0, la * la - along * along));
    const side = pole.clone().addScaledVector(n, -pole.dot(n)).normalize();
    const joint = s.clone().addScaledVector(n, along).addScaledVector(side, h);
    this.aim(upper, lower, joint.clone().sub(s));
    this.aim(lower, end, s.addScaledVector(n, d).sub(joint));
  }

  /**
   * Pose for this frame. `hands` are where the hands should be, in the seat's space ([left, right]);
   * `lean` bends the back forward (radians); `nod` and `look` tilt and turn the head.
   */
  pose(hands: [THREE.Vector3, THREE.Vector3], lean: number, nod: number, look: number): void {
    for (const [bone, q] of this.rest) bone.quaternion.copy(q);
    this.root.updateMatrixWorld(true);
    const toWorld = (v: THREE.Vector3) => this.root.localToWorld(v.clone());
    const dirWorld = (v: THREE.Vector3) => v.clone().transformDirection(this.root.matrixWorld);

    for (const [side, sx] of [['l', 1], ['r', -1]] as const) {
      const hip = this.root.worldToLocal(this.world(`thigh_${side}`));
      const foot = new THREE.Vector3(hip.x + sx * 0.04, this.ankleY, hip.z + 0.42);
      this.reach(`thigh_${side}`, `calf_${side}`, `foot_${side}`, toWorld(foot), dirWorld(new THREE.Vector3(0, 0.3, 1)));
      this.aim(`foot_${side}`, `ball_${side}`, dirWorld(new THREE.Vector3(0, -0.5, 1)));
    }
    for (const s of ['spine_01', 'spine_02', 'spine_03']) this.turn(s, X, lean / 3);
    this.turn('neck_01', Y, look * 0.4);
    this.turn('Head', Y, look * 0.6);
    this.turn('Head', X, nod);

    hands.forEach((target, i) => {
      const side = i === 0 ? 'l' : 'r';
      const sx = i === 0 ? 1 : -1;
      this.reach(`upperarm_${side}`, `lowerarm_${side}`, `hand_${side}`, toWorld(target), dirWorld(new THREE.Vector3(sx * 0.6, -1, -0.6)));
      this.aim(`hand_${side}`, `middle_01_${side}`, dirWorld(new THREE.Vector3(-sx * 0.5, 0.2, 1)));
    });
  }
}
