import * as THREE from "three";
import { BALL_RADIUS_M } from "../data/ball";
import { WORLD_UP, faceNormalS } from "../swing/frames";
import type { SwingAnalysis } from "../swing/pipeline";

const COLORS = {
    background: 0x16211a,
    grid: 0x2c3b30,
    gridCenter: 0x3e5344,
    target: 0x8fbf8a,
    shaft: 0xd8d2bf,
    arm: 0x76806c,
    hub: 0x4a5142,
    head: 0xf4f1e8,
    trail: 0x8fbf8a,
    face: 0xd99a4e,
    ball: 0xffffff,
    strike: 0xe8543f,
};

/** Face plate depth. Real clubheads vary, this is just thick enough to read as a plate. */
const FACE_DEPTH = 0.014;

const TRAIL_SECONDS = 0.55;

/**
 * The swing replay.
 *
 * Built once and driven imperatively. React owns the container and the play
 * button and nothing else, because pushing sixty frames a second through
 * reconciliation is the fastest way to make this stutter on a phone. Buffers are
 * allocated when a swing is loaded and only ever written into after that, so a
 * frame costs no allocation at all.
 */
export class SwingScene {
    private renderer: THREE.WebGLRenderer;
    private scene = new THREE.Scene();
    private camera: THREE.PerspectiveCamera;
    private root = new THREE.Group();

    private shaft: THREE.Mesh;
    private arm: THREE.Mesh;
    private hands: THREE.Mesh;
    private hubMesh: THREE.Mesh;
    private head: THREE.Mesh;
    private faceLine: THREE.Line;
    private trail: THREE.Line;
    private trailPositions: Float32Array = new Float32Array(0);
    private ball: THREE.Mesh;
    private strikeMarker: THREE.Mesh;
    private grid: THREE.GridHelper;
    private targetLine: THREE.Line;

    private analysis: SwingAnalysis | null = null;
    private frame = 0;
    private playing = false;
    private rafId = 0;
    private lastTime = 0;
    private needsRender = true;
    private disposed = false;

    private orbit = { azimuth: -0.9, elevation: 0.32, radius: 3.1 };
    private pointerId: number | null = null;
    private lastPointer = { x: 0, y: 0 };

    private frameListener: ((frame: number, total: number) => void) | null = null;
    private resizeObserver: ResizeObserver;

    constructor(private container: HTMLElement) {
        this.renderer = new THREE.WebGLRenderer({
            antialias: true,
            alpha: false,
            powerPreference: "low-power",
        });
        // Past two the extra pixels cost real frames and buy nothing visible.
        this.renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
        this.renderer.setClearColor(COLORS.background, 1);
        container.appendChild(this.renderer.domElement);
        this.renderer.domElement.style.touchAction = "none";
        this.renderer.domElement.style.display = "block";
        this.renderer.domElement.style.width = "100%";
        this.renderer.domElement.style.height = "100%";

        this.camera = new THREE.PerspectiveCamera(45, 1, 0.05, 60);
        this.scene.add(this.root);
        this.scene.add(new THREE.AmbientLight(0xffffff, 1.6));
        const key = new THREE.DirectionalLight(0xffffff, 1.5);
        key.position.set(2, 4, 2);
        this.scene.add(key);

        this.grid = new THREE.GridHelper(5, 20, COLORS.gridCenter, COLORS.grid);
        const gridMaterial = this.grid.material as THREE.Material;
        gridMaterial.transparent = true;
        gridMaterial.opacity = 0.5;
        this.root.add(this.grid);

        this.targetLine = new THREE.Line(
            lineGeometry(2),
            new THREE.LineBasicMaterial({ color: COLORS.target }),
        );
        this.root.add(this.targetLine);

        this.shaft = new THREE.Mesh(
            new THREE.CylinderGeometry(0.008, 0.008, 1, 6),
            new THREE.MeshLambertMaterial({ color: COLORS.shaft }),
        );
        this.root.add(this.shaft);

        // Second segment: hub to hands. Drawn thicker and darker so it reads as an
        // arm rather than part of the club.
        this.arm = new THREE.Mesh(
            new THREE.CylinderGeometry(0.018, 0.014, 1, 6),
            new THREE.MeshLambertMaterial({ color: COLORS.arm }),
        );
        this.root.add(this.arm);

        this.hands = new THREE.Mesh(
            new THREE.SphereGeometry(0.03, 10, 8),
            new THREE.MeshLambertMaterial({ color: COLORS.arm }),
        );
        this.root.add(this.hands);

        this.hubMesh = new THREE.Mesh(
            new THREE.SphereGeometry(0.045, 10, 8),
            new THREE.MeshLambertMaterial({ color: COLORS.hub }),
        );
        this.root.add(this.hubMesh);

        // Unit box, rescaled to the club's real face width/height/depth per swing and
        // oriented every frame to the clubhead's own face-local axes, the same ones
        // src/swing/strike.ts uses for its strike-location math.
        this.head = new THREE.Mesh(
            new THREE.BoxGeometry(1, 1, 1),
            new THREE.MeshLambertMaterial({ color: COLORS.head }),
        );
        this.root.add(this.head);

        this.faceLine = new THREE.Line(
            lineGeometry(2),
            new THREE.LineBasicMaterial({ color: COLORS.face }),
        );
        this.root.add(this.faceLine);

        this.trail = new THREE.Line(
            new THREE.BufferGeometry(),
            new THREE.LineBasicMaterial({ color: COLORS.trail, transparent: true, opacity: 0.85 }),
        );
        this.root.add(this.trail);

        this.ball = new THREE.Mesh(
            new THREE.SphereGeometry(BALL_RADIUS_M, 10, 8),
            new THREE.MeshLambertMaterial({ color: COLORS.ball }),
        );
        this.root.add(this.ball);

        // Marks where the clubhead actually came closest to the ball. Hidden until
        // the replay reaches that instant, and only stands out in a mis-hit color
        // when the strike missed the center of the face.
        this.strikeMarker = new THREE.Mesh(
            new THREE.SphereGeometry(0.009, 10, 8),
            new THREE.MeshBasicMaterial({ color: COLORS.strike }),
        );
        this.strikeMarker.visible = false;
        this.root.add(this.strikeMarker);

        // These three get rewritten every frame. Three caches a bounding sphere the
        // first time it culls and never recomputes it, so a line that starts life
        // empty or tiny gets culled away for good once it grows. Nothing here is ever
        // off screen anyway, so skip the test rather than recompute bounds per frame.
        this.trail.frustumCulled = false;
        this.faceLine.frustumCulled = false;
        this.targetLine.frustumCulled = false;

        this.resizeObserver = new ResizeObserver(() => this.resize());
        this.resizeObserver.observe(container);
        this.resize();
        this.bindPointer();
        this.tick(performance.now());
    }

    onFrame(cb: (frame: number, total: number) => void): void {
        this.frameListener = cb;
    }

    setSwing(analysis: SwingAnalysis): void {
        this.analysis = analysis;
        const n = analysis.clubheadPath.length;

        // One allocation per swing, then nothing.
        this.trailPositions = new Float32Array(n * 3);
        const geometry = this.trail.geometry as THREE.BufferGeometry;
        geometry.setAttribute("position", new THREE.BufferAttribute(this.trailPositions, 3));
        geometry.setDrawRange(0, 0);

        // The grip is the origin, so the ground sits a shaft length below it. Ball
        // position is the same fixed point src/swing/strike.ts computes the strike
        // location against, wherever the clubhead rested at address.
        const groundY = analysis.clubheadPath[0].y;
        this.grid.position.y = groundY;
        const ball = analysis.strike.ballPosition;
        this.ball.position.set(ball.x, ball.y, ball.z);

        setLine(this.targetLine, [
            new THREE.Vector3(this.ball.position.x - 1.2, groundY + 0.002, this.ball.position.z),
            new THREE.Vector3(this.ball.position.x + 2.4, groundY + 0.002, this.ball.position.z),
        ]);

        this.head.scale.set(analysis.club.faceWidth, analysis.club.faceHeight, FACE_DEPTH);
        (this.head.material as THREE.MeshLambertMaterial).color.set(
            analysis.strike.zone === "center" ? COLORS.head : COLORS.strike,
        );

        const contact = analysis.strike.contactPoint;
        this.strikeMarker.position.set(contact.x, contact.y, contact.z);
        this.strikeMarker.visible = false;

        this.shaft.scale.y = analysis.shaftLength;
        this.hubMesh.position.set(analysis.hub.x, analysis.hub.y, analysis.hub.z);
        this.arm.scale.y = Math.hypot(analysis.hub.x, analysis.hub.y, analysis.hub.z) || 1;
        this.frame = 0;
        this.setFrame(0);
    }

    setFrame(frame: number): void {
        const a = this.analysis;
        if (!a) return;
        const n = a.clubheadPath.length;
        this.frame = Math.max(0, Math.min(n - 1, Math.round(frame)));

        const p = a.clubheadPath[this.frame];
        const g = a.gripPath[this.frame];
        const headPos = TMP_HEAD.set(p.x, p.y, p.z);
        const gripPos = TMP_GRIP.set(g.x, g.y, g.z);
        const hubPos = TMP_HUB.set(a.hub.x, a.hub.y, a.hub.z);

        this.head.position.copy(headPos);
        this.hands.position.copy(gripPos);

        // Two segments now: hub to hands, then hands to clubhead. The hands really do
        // travel, and pinning them at a point is what used to make this look like a
        // windmill instead of a swing.
        placeSegment(this.arm, hubPos, gripPos);
        placeSegment(this.shaft, gripPos, headPos);

        const q = a.orientation[this.frame];
        const quat = new THREE.Quaternion(q.x, q.y, q.z, q.w);
        const faceS = faceNormalS(a.hand);
        const faceNormal = new THREE.Vector3(faceS.x, faceS.y, faceS.z).applyQuaternion(quat);
        const face = faceNormal.clone().multiplyScalar(0.22);
        setLine(this.faceLine, [headPos, headPos.clone().add(face)]);

        // Same face-local axes src/swing/strike.ts decomposes offsets into: "up" is
        // whatever is perpendicular to world up and the face normal, "across" is
        // perpendicular to both. Orienting the box mesh to them every frame keeps the
        // rendered face plate honest to the physics, not just a fixed prop on the shaft.
        const worldUp = new THREE.Vector3(WORLD_UP.x, WORLD_UP.y, WORLD_UP.z);
        const vertical = worldUp
            .clone()
            .sub(faceNormal.clone().multiplyScalar(worldUp.dot(faceNormal)))
            .normalize();
        const lateral = new THREE.Vector3().crossVectors(vertical, faceNormal);
        this.head.quaternion.setFromRotationMatrix(
            new THREE.Matrix4().makeBasis(lateral, vertical, faceNormal),
        );

        if (a.strike.contactMade) {
            this.strikeMarker.visible = a.times[this.frame] >= a.strike.contactSec;
        }

        this.updateTrail();
        this.needsRender = true;
        this.frameListener?.(this.frame, n);
    }

    /** Trail is a fixed window behind the clubhead, so it reads as motion not history. */
    private updateTrail(): void {
        const a = this.analysis;
        if (!a) return;
        const cutoff = a.times[this.frame] - TRAIL_SECONDS;
        let start = 0;
        while (start < this.frame && a.times[start] < cutoff) start++;

        let write = 0;
        for (let i = start; i <= this.frame; i++) {
            const p = a.clubheadPath[i];
            this.trailPositions[write++] = p.x;
            this.trailPositions[write++] = p.y;
            this.trailPositions[write++] = p.z;
        }
        const geometry = this.trail.geometry as THREE.BufferGeometry;
        const attribute = geometry.getAttribute("position") as THREE.BufferAttribute;
        attribute.needsUpdate = true;
        geometry.setDrawRange(0, write / 3);
    }

    play(): void {
        if (!this.analysis) return;
        // Restart if it is sitting at the end.
        if (this.frame >= this.analysis.clubheadPath.length - 1) this.setFrame(0);
        this.playing = true;
        this.lastTime = performance.now();
    }

    pause(): void {
        this.playing = false;
    }

    isPlaying(): boolean {
        return this.playing;
    }

    dispose(): void {
        this.disposed = true;
        cancelAnimationFrame(this.rafId);
        this.resizeObserver.disconnect();
        this.unbindPointer();
        this.scene.traverse((object) => {
            const mesh = object as THREE.Mesh;
            mesh.geometry?.dispose?.();
            const material = mesh.material;
            if (Array.isArray(material)) material.forEach((m) => m.dispose());
            else material?.dispose?.();
        });
        this.renderer.dispose();
        this.renderer.domElement.remove();
    }

    private tick = (now: number): void => {
        if (this.disposed) return;
        this.rafId = requestAnimationFrame(this.tick);

        if (this.playing && this.analysis) {
            const dt = (now - this.lastTime) / 1000;
            this.lastTime = now;
            // Half speed. A real swing is over in about a second.
            const advance = (dt * 0.5) / Math.max(1e-6, this.averageStep());
            const next = this.frame + advance;
            if (next >= this.analysis.clubheadPath.length - 1) {
                this.setFrame(this.analysis.clubheadPath.length - 1);
                this.playing = false;
            } else {
                this.setFrame(next);
            }
        }

        if (this.needsRender) {
            this.needsRender = false;
            this.renderer.render(this.scene, this.camera);
        }
    };

    private averageStep(): number {
        const a = this.analysis;
        if (!a || a.times.length < 2) return 1 / 400;
        return a.times[a.times.length - 1] / (a.times.length - 1);
    }

    private resize(): void {
        const width = this.container.clientWidth;
        const height = this.container.clientHeight;
        if (width === 0 || height === 0) return;
        this.renderer.setSize(width, height, false);
        this.camera.aspect = width / height;
        this.camera.updateProjectionMatrix();
        this.updateCamera();
    }

    private updateCamera(): void {
        const { azimuth, elevation, radius } = this.orbit;
        const target = new THREE.Vector3(0.2, -0.35, 0);
        this.camera.position.set(
            target.x + radius * Math.cos(elevation) * Math.cos(azimuth),
            target.y + radius * Math.sin(elevation),
            target.z + radius * Math.cos(elevation) * Math.sin(azimuth),
        );
        this.camera.lookAt(target);
        this.needsRender = true;
    }

    private bindPointer(): void {
        const el = this.renderer.domElement;
        el.addEventListener("pointerdown", this.onPointerDown);
        el.addEventListener("pointermove", this.onPointerMove);
        el.addEventListener("pointerup", this.onPointerUp);
        el.addEventListener("pointercancel", this.onPointerUp);
    }

    private unbindPointer(): void {
        const el = this.renderer.domElement;
        el.removeEventListener("pointerdown", this.onPointerDown);
        el.removeEventListener("pointermove", this.onPointerMove);
        el.removeEventListener("pointerup", this.onPointerUp);
        el.removeEventListener("pointercancel", this.onPointerUp);
    }

    private onPointerDown = (e: PointerEvent): void => {
        this.pointerId = e.pointerId;
        this.lastPointer = { x: e.clientX, y: e.clientY };
        this.renderer.domElement.setPointerCapture(e.pointerId);
    };

    private onPointerMove = (e: PointerEvent): void => {
        if (this.pointerId !== e.pointerId) return;
        const dx = e.clientX - this.lastPointer.x;
        const dy = e.clientY - this.lastPointer.y;
        this.lastPointer = { x: e.clientX, y: e.clientY };
        this.orbit.azimuth -= dx * 0.008;
        this.orbit.elevation = clamp(this.orbit.elevation + dy * 0.006, -0.2, 1.3);
        this.updateCamera();
    };

    private onPointerUp = (e: PointerEvent): void => {
        if (this.pointerId !== e.pointerId) return;
        this.pointerId = null;
        this.renderer.domElement.releasePointerCapture?.(e.pointerId);
    };
}

const UP = new THREE.Vector3(0, 1, 0);

const clamp = (x: number, lo: number, hi: number): number => Math.min(hi, Math.max(lo, x));

function lineGeometry(points: number): THREE.BufferGeometry {
    const geometry = new THREE.BufferGeometry();
    geometry.setAttribute("position", new THREE.BufferAttribute(new Float32Array(points * 3), 3));
    return geometry;
}

function setLine(line: THREE.Line, points: THREE.Vector3[]): void {
    const attribute = line.geometry.getAttribute("position") as THREE.BufferAttribute;
    points.forEach((p, i) => attribute.setXYZ(i, p.x, p.y, p.z));
    attribute.needsUpdate = true;
    line.geometry.setDrawRange(0, points.length);
}

// Scratch vectors, reused so a frame costs no allocation.
const TMP_HEAD = new THREE.Vector3();
const TMP_GRIP = new THREE.Vector3();
const TMP_HUB = new THREE.Vector3();
const TMP_DIR = new THREE.Vector3();

/** Stand a cylinder between two points. Its length is already set by scale.y. */
function placeSegment(mesh: THREE.Mesh, from: THREE.Vector3, to: THREE.Vector3): void {
    mesh.position.copy(from).add(to).multiplyScalar(0.5);
    TMP_DIR.copy(to).sub(from);
    const length = TMP_DIR.length();
    if (length < 1e-6) return;
    mesh.quaternion.setFromUnitVectors(UP, TMP_DIR.divideScalar(length));
}
