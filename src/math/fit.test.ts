import { describe, expect, it } from "vitest";
import { evalLinear, evalQuadratic, linearFit, quadraticFit } from "./fit";

describe("linearFit", () => {
    it("recovers an exact line", () => {
        const xs = [0, 1, 2, 3, 4];
        const ys = xs.map((x) => 3 + 2 * x);
        const fit = linearFit(xs, ys);
        expect(fit.slope).toBeCloseTo(2, 9);
        expect(fit.intercept).toBeCloseTo(3, 9);
        expect(evalLinear(fit, 10)).toBeCloseTo(23, 9);
    });
});

describe("quadraticFit", () => {
    it("recovers an exact parabola", () => {
        const xs = [-2, -1, 0, 1, 2];
        const ys = xs.map((x) => 1 - 2 * x + 4 * x * x);
        const fit = quadraticFit(xs, ys);
        expect(fit.a).toBeCloseTo(1, 9);
        expect(fit.b).toBeCloseTo(-2, 9);
        expect(fit.c).toBeCloseTo(4, 9);
        expect(evalQuadratic(fit, 3)).toBeCloseTo(1 - 6 + 36, 9);
    });

    it("falls back to a line when x does not vary", () => {
        const fit = quadraticFit([1, 1, 1], [5, 5, 5]);
        expect(fit.a).toBeCloseTo(5, 9);
    });
});
