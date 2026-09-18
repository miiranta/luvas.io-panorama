import { Mat3 } from '../math/matrix3';
import { opticalAxis } from '../math/so3';
import { Keyframe } from './keyframe';

const HOT_COMPOSE_FRAMES = 8;
const HOT_WORK_FRAMES = 3;
const UNARCHIVED_COMPOSE_FRAMES = 60;

export class KeyframeStore {
    private frames: Keyframe[] = [];
    private nextId = 0;

    get all(): readonly Keyframe[] {
        return this.frames;
    }

    get active(): Keyframe[] {
        return this.frames.filter((frame) => !frame.rejected);
    }

    get isEmpty(): boolean {
        return this.frames.length === 0;
    }

    get storedBytes(): number {
        return this.frames.reduce((total, frame) => total + frame.storedBytes, 0);
    }

    allocateId(): number {
        return this.nextId++;
    }

    add(frame: Keyframe): void {
        this.frames.push(frame);
    }

    byId(id: number): Keyframe | undefined {
        return this.frames.find((frame) => frame.id === id);
    }

    latestActive(): Keyframe | undefined {
        return this.active.at(-1);
    }

    nearest(
        rotation: Mat3,
        limit: number,
        candidates: readonly Keyframe[] = this.active,
    ): Keyframe[] {
        const [x, y, z] = opticalAxis(rotation);
        return candidates
            .map((frame) => {
                const [ox, oy, oz] = opticalAxis(frame.rotation);
                return { frame, score: x * ox + y * oy + z * oz };
            })
            .sort((a, b) => b.score - a.score || b.frame.id - a.frame.id)
            .slice(0, limit)
            .map((entry) => entry.frame);
    }

    clear(): void {
        this.frames = [];
        this.nextId = 0;
    }

    async trim(): Promise<void> {
        const active = this.active;
        const composeBudget = Keyframe.canArchive ? HOT_COMPOSE_FRAMES : UNARCHIVED_COMPOSE_FRAMES;
        const hotCompose = new Set(active.slice(-composeBudget).map((frame) => frame.id));
        const hotWork = new Set(active.slice(-HOT_WORK_FRAMES).map((frame) => frame.id));
        for (const frame of this.frames) {
            if (!hotWork.has(frame.id)) frame.work = null;
            if (!hotCompose.has(frame.id)) await frame.archiveCompose();
        }
    }
}
