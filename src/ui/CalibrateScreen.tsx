import { CLUBS, type ClubType } from "../data/clubs";
import { useProfile } from "../profile/ProfileContext";
import type { ClubOverride } from "../profile/types";

const GROUPS: { type: ClubType; label: string }[] = [
    { type: "wood", label: "Fairway woods" },
    { type: "hybrid", label: "Hybrids" },
    { type: "iron", label: "Irons" },
    { type: "wedge", label: "Wedges" },
];

const MM_PER_M = 1000;

interface FieldSpec {
    key: keyof ClubOverride;
    label: string;
    /** Display value in club units (meters -> mm for face dimensions). */
    toDisplay: (v: number) => number;
    toStored: (v: number) => number;
    step: number;
}

const FIELDS: FieldSpec[] = [
    { key: "smash", label: "Smash", toDisplay: (v) => v, toStored: (v) => v, step: 0.01 },
    {
        key: "launchFactor",
        label: "Launch factor",
        toDisplay: (v) => v,
        toStored: (v) => v,
        step: 0.01,
    },
    {
        key: "faceWidth",
        label: "Face width (mm)",
        toDisplay: (v) => v * MM_PER_M,
        toStored: (v) => v / MM_PER_M,
        step: 1,
    },
    {
        key: "faceHeight",
        label: "Face height (mm)",
        toDisplay: (v) => v * MM_PER_M,
        toStored: (v) => v / MM_PER_M,
        step: 1,
    },
];

export function CalibrateScreen({ onDone }: { onDone: () => void }) {
    const { profile, setClubOverride, resetClubOverride, resolveClub, setMount } = useProfile();
    const mount = profile.mount;

    return (
        <div className="screen">
            <header className="screen-head row">
                <h1>Calibrate clubs</h1>
                <button type="button" className="link" onClick={onDone}>
                    Done
                </button>
            </header>

            <div className="scroll">
                <section>
                    <h2 className="group-label">Sensor mount</h2>
                    <div className="calibrate-card">
                        <p className="muted">
                            {mount
                                ? `Learned ${new Date(mount.ts).toLocaleDateString()} from a swing that put the shaft ${mount.lieAngleDeg.toFixed(0)} degrees off the ground at address.`
                                : "Not set up yet. The next swing you record works it out."}
                        </p>
                        <p className="muted">
                            Which way up the Stick sits on the shaft is read off a swing, so there
                            is nothing here to enter. Relearn it whenever the strap moves, and do it
                            on a swing that feels normal to you: the line you swing on is the line
                            every path angle afterwards is measured against.
                        </p>
                        {mount ? (
                            <button type="button" className="link" onClick={() => setMount(null)}>
                                Forget it and relearn on the next swing
                            </button>
                        ) : null}
                    </div>
                </section>
                <p className="muted">
                    These are estimates, not measured specs. Override any of them with numbers you
                    actually know for your clubs; leave the rest alone.
                </p>

                {GROUPS.map((group) => (
                    <section key={group.type}>
                        <h2 className="group-label">{group.label}</h2>
                        {CLUBS.filter((c) => c.type === group.type).map((club) => {
                            const resolved = resolveClub(club.id);
                            const hasOverride = Boolean(profile.clubOverrides[club.id]);
                            return (
                                <div className="calibrate-card" key={club.id}>
                                    <div className="calibrate-card-head">
                                        <span className="club-id">{club.label}</span>
                                        {hasOverride ? (
                                            <button
                                                type="button"
                                                className="link"
                                                onClick={() => resetClubOverride(club.id)}
                                            >
                                                Reset to stock
                                            </button>
                                        ) : null}
                                    </div>
                                    <div className="calibrate-fields">
                                        {FIELDS.map((field) => (
                                            <label className="calibrate-field" key={field.key}>
                                                <span>{field.label}</span>
                                                <input
                                                    type="number"
                                                    step={field.step}
                                                    value={field.toDisplay(resolved[field.key])}
                                                    onChange={(e) => {
                                                        const raw = e.target.valueAsNumber;
                                                        if (Number.isNaN(raw)) return;
                                                        setClubOverride(club.id, {
                                                            [field.key]: field.toStored(raw),
                                                        });
                                                    }}
                                                />
                                            </label>
                                        ))}
                                    </div>
                                </div>
                            );
                        })}
                    </section>
                ))}
            </div>
        </div>
    );
}
