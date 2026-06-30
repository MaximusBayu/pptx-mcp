"use client";

// Staged progress indicator shared by the upload page and the editor's lazy
// preview render. Determinate (pct given) for the real byte upload; indeterminate
// for server-side stages whose duration we can't measure.
export function UploadProgress({ stage, pct }: { stage: string; pct?: number }) {
  const determinate = typeof pct === "number";
  return (
    <div className="space-y-2" role="status" aria-live="polite">
      <p className="text-sm text-matcha-700">{stage}</p>
      <div className="h-2 w-full overflow-hidden rounded bg-matcha-100">
        {determinate ? (
          <div data-testid="bar-fill" className="h-full bg-matcha-500 transition-all" style={{ width: `${pct}%` }} />
        ) : (
          <div data-testid="bar-indeterminate" className="h-full w-1/3 animate-pulse bg-matcha-400" />
        )}
      </div>
    </div>
  );
}
