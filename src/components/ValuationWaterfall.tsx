import React from "react";
import type { Waterfall, WaterfallBar } from "../appraisal/stage3a_waterfall";
import type { ValuationNarrative } from "../appraisal/stage3b_narration";

/**
 * How the fair-value price was built (plan docs/plans/2026-09-16-stage3-blend-valuation.md,
 * phase 5): the Stage 3a contribution waterfall on a log price axis, from a typical print by this
 * artist in this technique to this lot's median, with Stage 3b's narration beside it. Bars are in GBP in the report and
 * converted with the view's own currency function, so they match the headline range.
 */
interface Props {
  waterfall: Waterfall;
  narrative?: ValuationNarrative | null;
  low: number;
  high: number;
  /** GBP -> display currency, the same conversion the headline range uses. */
  convert: (gbp: number) => number;
  symbol: string;
}

const UP = "#3F6B4E";      // muted green: this step raises the price
const DOWN = "#4C0B2A";    // claret: this step lowers it
const LEVEL = "#C0AA84";   // gold: a price level (start, model price, median)

export function ValuationWaterfall({ waterfall, narrative, low, high, convert, symbol }: Props) {
  const bars = waterfall.bars;
  const prices = bars.flatMap((b) => [b.fromGBP, b.toGBP]).filter((p) => p > 0);
  const lo = Math.log(Math.min(...prices) * 0.8);
  const hi = Math.log(Math.max(...prices) * 1.25);
  const x = (gbp: number) => ((Math.log(Math.max(gbp, 1)) - lo) / (hi - lo)) * 100;
  const fmt = (gbp: number) => `${symbol}${Math.round(convert(gbp)).toLocaleString()}`;
  const ticks = niceTicks(Math.exp(lo), Math.exp(hi));

  const row = (b: WaterfallBar) => {
    const isStep = b.kind === "factor" || b.kind === "comps";
    const isLevel = b.kind === "baseline" || b.kind === "subtotal" || b.kind === "total";
    const up = b.logEffect >= 0;
    const left = Math.min(x(b.fromGBP), x(b.toGBP));
    const width = Math.max(Math.abs(x(b.toGBP) - x(b.fromGBP)), 0.6);
    return (
      <div key={b.key} className={`grid grid-cols-[minmax(0,1.1fr)_minmax(0,1fr)_auto] items-center gap-3 py-1 ${isLevel ? "border-t border-rosebery-border" : ""}`}>
        <span className={`text-xs leading-snug ${isLevel ? "font-semibold text-rosebery-charcoal" : b.kind === "note" ? "italic text-rosebery-muted" : "text-rosebery-text-normal"}`}>{b.label}</span>
        <div className="relative h-4">
          {ticks.map((t) => <span key={t} className="absolute top-0 h-4 border-l border-dashed border-rosebery-border" style={{ left: `${x(t)}%` }} />)}
          {isStep && <span className="absolute top-0.5 h-3 rounded-[2px]" style={{ left: `${left}%`, width: `${width}%`, background: up ? UP : DOWN, opacity: b.kind === "comps" ? 0.75 : 1 }} />}
          {isLevel && <span className="absolute top-0 h-4 w-[3px] -ml-[1px] rounded-full" style={{ left: `${x(b.toGBP)}%`, background: b.kind === "total" ? DOWN : LEVEL }} />}
        </div>
        <span className={`text-xs tabular-nums text-right whitespace-nowrap ${isLevel ? "font-semibold text-rosebery-charcoal" : "text-rosebery-muted"}`}>
          {isStep ? `×${b.multiplier.toFixed(2)}` : b.kind === "note" ? "—" : fmt(b.toGBP)}
        </span>
      </div>
    );
  };

  return (
    <div className="grid grid-cols-1 xl:grid-cols-5 gap-8">
      <div className="xl:col-span-3 min-w-0">
        <div className="grid grid-cols-[minmax(0,1.1fr)_minmax(0,1fr)_auto] gap-3 mb-1">
          <span />
          <div className="relative h-4 text-[9px] font-mono text-rosebery-muted">
            {ticks.map((t) => <span key={t} className="absolute -translate-x-1/2 whitespace-nowrap" style={{ left: `${x(t)}%` }}>{fmt(t)}</span>)}
          </div>
          <span className="text-[9px] font-mono text-rosebery-muted text-right">step</span>
        </div>
        {bars.map(row)}
        <div className="flex flex-wrap items-center gap-4 mt-3 text-[10px] text-rosebery-muted">
          <span className="flex items-center gap-1.5"><span className="inline-block w-3 h-2 rounded-[2px]" style={{ background: UP }} />raises the price</span>
          <span className="flex items-center gap-1.5"><span className="inline-block w-3 h-2 rounded-[2px]" style={{ background: DOWN }} />lowers it</span>
          <span>Log price scale. The fair-value range {symbol}{low.toLocaleString()}–{symbol}{high.toLocaleString()} is the 80% range around the median.</span>
        </div>
        {waterfall.notes.length > 0 && <p className="mt-2 text-[10px] italic text-rosebery-muted">{waterfall.notes.join(" · ")}</p>}
      </div>

      <div className="xl:col-span-2 min-w-0">
        {narrative ? (
          <div className="space-y-3">
            <p className="font-serif text-lg leading-snug text-rosebery-charcoal">{narrative.headline}</p>
            <ul className="space-y-1.5">
              {narrative.keyDrivers.map((d, i) => (
                <li key={i} className="flex gap-2 text-xs leading-relaxed text-rosebery-text-normal">
                  <span className="shrink-0 font-bold" style={{ color: d.direction === "up" ? UP : d.direction === "down" ? DOWN : LEVEL }}>
                    {d.direction === "up" ? "▲" : d.direction === "down" ? "▼" : "●"}
                  </span>
                  <span><span className="font-semibold">{d.factor}.</span> {d.explanation}</span>
                </li>
              ))}
            </ul>
            <p className="text-xs leading-relaxed text-rosebery-text-normal">{narrative.narrative}</p>
            {narrative.caveats.length > 0 && (
              <ul className="list-disc pl-4 space-y-0.5 text-[11px] text-rosebery-muted">
                {narrative.caveats.map((c, i) => <li key={i}>{c}</li>)}
              </ul>
            )}
          </div>
        ) : (
          <p className="text-xs italic text-rosebery-muted">No commentary for this valuation: the chart and the reasoning below the range stand on their own.</p>
        )}
      </div>
    </div>
  );
}

/** Round-number ticks inside [min, max], at most five: 1-2-5 per decade, finer when the span is narrow. */
function niceTicks(min: number, max: number): number[] {
  const at = (mantissas: number[]) => {
    const out: number[] = [];
    for (let e = Math.floor(Math.log10(min)); e <= Math.ceil(Math.log10(max)); e++) {
      for (const m of mantissas) {
        const v = m * Math.pow(10, e);
        if (v >= min && v <= max) out.push(v);
      }
    }
    return out;
  };
  let out = at([1, 2, 5]);
  if (out.length < 3) out = at([1, 1.5, 2, 3, 5, 7]);
  // Too many: keep every other tick, then the ends are still round numbers.
  return out.length > 5 ? out.filter((_, i) => i % 2 === 0) : out;
}
