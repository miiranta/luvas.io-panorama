import {
    ChangeDetectionStrategy,
    Component,
    computed,
    inject,
    output,
    signal,
} from '@angular/core';
import { ParamGroup } from '../../core/models/params';
import { PARAM_SPECS, ParamSpec } from '../../core/models/param-spec';
import { StitcherService } from '../../core/services/stitcher.service';

const GROUP_TITLES: Record<ParamGroup, string> = {
    detect: 'Detecção',
    match: 'Casamento',
    model: 'RANSAC',
    global: 'Global',
    compose: 'Composição',
};

@Component({
    selector: 'app-settings-sheet',
    templateUrl: './settings-sheet.html',
    styleUrl: './settings-sheet.scss',
    changeDetection: ChangeDetectionStrategy.OnPush,
})
export class SettingsSheet {
    private readonly stitcher = inject(StitcherService);

    readonly close = output<void>();
    readonly params = this.stitcher.params;
    readonly showAdvanced = signal(false);

    readonly groups = computed(() => {
        const advanced = this.showAdvanced();
        const groups: { group: ParamGroup; title: string; specs: ParamSpec[] }[] = [];
        for (const group of Object.keys(GROUP_TITLES) as ParamGroup[]) {
            const specs = PARAM_SPECS.filter(
                (spec) => spec.group === group && (advanced || !spec.advanced),
            );
            if (specs.length > 0) groups.push({ group, title: GROUP_TITLES[group], specs });
        }
        return groups;
    });

    value(spec: ParamSpec): number | boolean | string {
        const group = this.params()[spec.group] as unknown as Record<
            string,
            number | boolean | string
        >;
        return group[spec.key];
    }

    asNumber(spec: ParamSpec): number {
        return Number(this.value(spec));
    }

    asBool(spec: ParamSpec): boolean {
        return Boolean(this.value(spec));
    }

    asText(spec: ParamSpec): string {
        return String(this.value(spec));
    }

    shown(spec: ParamSpec): string {
        const value = this.asNumber(spec);
        if (Number.isInteger(value)) return String(value);
        return value < 0.02 ? value.toFixed(4) : value.toFixed(2);
    }

    onRange(spec: ParamSpec, event: Event): void {
        this.apply(spec, Number((event.target as HTMLInputElement).value));
    }

    onChoice(spec: ParamSpec, event: Event): void {
        this.apply(spec, (event.target as HTMLSelectElement).value);
    }

    onToggle(spec: ParamSpec): void {
        this.apply(spec, !this.asBool(spec));
    }

    private apply(spec: ParamSpec, value: number | boolean | string): void {
        this.stitcher.updateParam(spec.group, spec.key, value);
        if (spec.restage === 'compose' || spec.restage === 'global') this.stitcher.recompose();
    }

    reset(): void {
        this.stitcher.resetParams();
        this.stitcher.recompose();
    }
}
