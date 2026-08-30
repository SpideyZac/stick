export interface LinearFit {
    slope: number;
    intercept: number;
}

/** Least squares line through (xs[i], ys[i]). */
export function linearFit(xs: readonly number[], ys: readonly number[]): LinearFit {
    const n = xs.length;
    let sumX = 0;
    let sumY = 0;
    let sumXY = 0;
    let sumXX = 0;
    for (let i = 0; i < n; i++) {
        sumX += xs[i];
        sumY += ys[i];
        sumXY += xs[i] * ys[i];
        sumXX += xs[i] * xs[i];
    }
    const denominator = n * sumXX - sumX * sumX;
    if (Math.abs(denominator) < 1e-12) return { slope: 0, intercept: sumY / n };
    const slope = (n * sumXY - sumX * sumY) / denominator;
    const intercept = (sumY - slope * sumX) / n;
    return { slope, intercept };
}

export const evalLinear = (fit: LinearFit, at: number): number => fit.slope * at + fit.intercept;

export interface QuadraticFit {
    a: number;
    b: number;
    c: number;
}

/**
 * Least squares parabola y = a + b*x + c*x^2. Falls back to a linear fit if the
 * window is degenerate (fewer than 3 points, or all the same x), since that is
 * the most that data can support.
 */
export function quadraticFit(xs: readonly number[], ys: readonly number[]): QuadraticFit {
    const n = xs.length;
    let s0 = 0;
    let s1 = 0;
    let s2 = 0;
    let s3 = 0;
    let s4 = 0;
    let sy0 = 0;
    let sy1 = 0;
    let sy2 = 0;
    for (let i = 0; i < n; i++) {
        const x = xs[i];
        const y = ys[i];
        const x2 = x * x;
        s0 += 1;
        s1 += x;
        s2 += x2;
        s3 += x2 * x;
        s4 += x2 * x2;
        sy0 += y;
        sy1 += x * y;
        sy2 += x2 * y;
    }

    // Solve the 3x3 normal equations [s0 s1 s2; s1 s2 s3; s2 s3 s4] [a b c]' = [sy0 sy1 sy2]'.
    const det = s0 * (s2 * s4 - s3 * s3) - s1 * (s1 * s4 - s3 * s2) + s2 * (s1 * s3 - s2 * s2);
    if (Math.abs(det) < 1e-12) {
        const linear = linearFit(xs, ys);
        return { a: linear.intercept, b: linear.slope, c: 0 };
    }

    const detA =
        sy0 * (s2 * s4 - s3 * s3) - s1 * (sy1 * s4 - s3 * sy2) + s2 * (sy1 * s3 - s2 * sy2);
    const detB =
        s0 * (sy1 * s4 - s3 * sy2) - sy0 * (s1 * s4 - s3 * s2) + s2 * (s1 * sy2 - sy1 * s2);
    const detC =
        s0 * (s2 * sy2 - sy1 * s3) - s1 * (s1 * sy2 - sy1 * s2) + sy0 * (s1 * s3 - s2 * s2);

    return { a: detA / det, b: detB / det, c: detC / det };
}

export const evalQuadratic = (fit: QuadraticFit, at: number): number =>
    fit.a + fit.b * at + fit.c * at * at;

export const evalQuadraticDeriv = (fit: QuadraticFit, at: number): number => fit.b + 2 * fit.c * at;
