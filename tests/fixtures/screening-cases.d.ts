/** Deterministic, fictional screening cases for offline regression and local benchmarks.
 * Gold labels are generated, not independently human-annotated; this is NOT the G2 quality set.
 */
export interface SyntheticScreeningCase {
    id: string;
    text: string;
    expected: "include" | "skip" | "review";
    category?: "grudge" | "rights" | "danger";
    media?: "image" | "audio" | "video";
}
export declare const syntheticScreeningCases: SyntheticScreeningCase[];
