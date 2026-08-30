import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ProfileProvider } from "../profile/ProfileContext";
import { App } from "./App";

function renderApp() {
    return render(
        <ProfileProvider>
            <App />
        </ProfileProvider>,
    );
}

// jsdom has no WebGL, so the replay is stubbed out. Everything the scene does is
// imperative three work with no logic of its own worth asserting here.
vi.mock("./SwingView", () => ({
    SwingView: ({ analysis }: { analysis: { clubheadPath: unknown[] } }) => (
        <div data-testid="replay">{analysis.clubheadPath.length} frames</div>
    ),
}));

beforeEach(() => {
    localStorage.clear();
    vi.useFakeTimers();
});
afterEach(() => {
    cleanup();
    vi.useRealTimers();
});

const click = (name: RegExp | string) => fireEvent.click(screen.getByRole("button", { name }));

/** Let the mock stream play all the way through and settle on the results. */
async function playThrough(ms = 10_000) {
    await act(async () => {
        await vi.advanceTimersByTimeAsync(ms);
    });
    expect(screen.getByTestId("replay")).toBeTruthy();
}

/** Pick a club, record, wait for the swing to land. */
async function recordASwing(clubLabel = "7I") {
    renderApp();
    click(new RegExp(`^${clubLabel}`, "i"));
    click(/^Use /);
    click("Record");
    await playThrough();
}

describe("app flow", () => {
    it("starts on the club picker with a default club selected", () => {
        renderApp();
        expect(screen.getByText("Pick your club")).toBeTruthy();
        expect(screen.getByRole("button", { name: /Use 7 Iron/ })).toBeTruthy();
    });

    it("offers every club except the driver", () => {
        renderApp();
        expect(screen.getByRole("button", { name: /^LW/ })).toBeTruthy();
        expect(screen.getByRole("button", { name: /^3W/ })).toBeTruthy();
        expect(screen.queryByRole("button", { name: /^DR/ })).toBeNull();
    });

    it("moves to the record screen and reports what it is waiting for", () => {
        renderApp();
        click(/^Use /);
        expect(screen.getByText(/Ready when you are/)).toBeTruthy();
        expect(screen.getByRole("button", { name: "Record" })).toBeTruthy();
    });

    it("lets the golfer switch handedness", () => {
        renderApp();
        click("Left handed");
        expect(screen.getByRole("button", { name: "Left handed" }).className).toContain("on");
    });

    it("records a swing and shows the stats and the replay", async () => {
        await recordASwing();
        expect(screen.getByText("Tempo")).toBeTruthy();
        expect(screen.getByText("Clubhead")).toBeTruthy();
        expect(screen.getByText("Carry")).toBeTruthy();
        expect(screen.getByText("Face to path")).toBeTruthy();
        expect(screen.getByRole("button", { name: "Hit another" })).toBeTruthy();
    });

    it("shows real numbers, not placeholders", async () => {
        await recordASwing();
        expect(screen.getAllByText(/\d+ mph/).length).toBeGreaterThan(0);
        expect(screen.getAllByText(/\d+ yd/).length).toBeGreaterThan(0);
        expect(screen.getByText(/ : 1$/)).toBeTruthy();
        // A bare dash is what the formatters emit when a number did not come through.
        expect(screen.queryByText("-")).toBeNull();
    });

    it("carries the chosen club through to the results", async () => {
        await recordASwing("PW");
        expect(screen.getByRole("heading", { name: "Pitching Wedge" })).toBeTruthy();
    });

    it("goes back to recording after a swing", async () => {
        await recordASwing();
        click("Done");
        expect(screen.getByRole("button", { name: "Record" })).toBeTruthy();
    });

    it("reports a slice as a slice", async () => {
        renderApp();
        click(/^Use /);
        fireEvent.change(screen.getByRole("combobox"), { target: { value: "slice" } });
        click("Record");
        await playThrough();
        expect(screen.getByText("Slice")).toBeTruthy();
        // An open face to path is what makes it a slice, so check that card and not
        // just the word, which also shows up under the face angle.
        expect(screen.getByText((text) => /^\d+(\.\d+)?° open$/.test(text))).toBeTruthy();
    });

    it("survives a waggle and still reports a swing", async () => {
        renderApp();
        click(/^Use /);
        fireEvent.change(screen.getByRole("combobox"), { target: { value: "waggle" } });
        click("Record");
        await playThrough(12_000);
        expect(screen.getByText("Tempo")).toBeTruthy();
    });
});
