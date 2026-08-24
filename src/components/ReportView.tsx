import React from "react";
import { PrintAnalysisReport, ASAAttributionResult, LegacyAttributionResult } from "../types";
import { resolveMethodLabel } from "../utils/resolveMethodLabel";
import { 
  User, 
  Award, 
  Clock, 
  Info, 
  ShieldAlert, 
  CheckCircle2, 
  Percent, 
  Coins, 
  Layers, 
  Clipboard, 
  Compass, 
  ExternalLink,
  Upload,
  X,
  Sparkles,
  Hash,
  FileText
} from "lucide-react";

interface ReportViewProps {
  report: PrintAnalysisReport;
  fileName?: string;
  fileSize?: string;
  imageUrl?: string;

  // Supplementary photos (arbitrary count, each with a user caption) —
  // display-only here, shown in the printed certificate.
  supplementaryImages?: Array<{ imageUrl: string; caption: string }>;

  onReAnalyze?: () => void;
  isLoading?: boolean;
  currency?: "USD" | "GBP" | "EUR";
  setCurrency?: (currency: "USD" | "GBP" | "EUR") => void;

  onUpdateReport?: (updated: PrintAnalysisReport) => void;
  userRole?: string;
  curatorName?: string;
}

interface EvidenceCropProps {
  imageUrl: string;
  box_2d: number[];
  label: string;
}

function EvidenceCrop({ imageUrl, box_2d, label }: EvidenceCropProps) {
  const containerRef = React.useRef<HTMLDivElement | null>(null);
  const [error, setError] = React.useState(false);
  const [thumbDataUrl, setThumbDataUrl] = React.useState<string | null>(null);
  const [zoomDataUrl, setZoomDataUrl] = React.useState<string | null>(null);
  const [hovered, setHovered] = React.useState(false);
  const [tooltipRect, setTooltipRect] = React.useState<DOMRect | null>(null);

  React.useEffect(() => {
    if (!imageUrl || !box_2d || box_2d.length !== 4) return;

    const img = new Image();
    img.style.imageOrientation = "from-image";
    img.onload = () => {
      // Bake EXIF rotation into a full-size canvas first
      img.style.position = "absolute";
      img.style.visibility = "hidden";
      document.body.appendChild(img);
      const full = document.createElement("canvas");
      full.width = img.naturalWidth;
      full.height = img.naturalHeight;
      const fctx = full.getContext("2d")!;
      fctx.imageSmoothingEnabled = true;
      fctx.imageSmoothingQuality = "high";
      fctx.drawImage(img, 0, 0);
      document.body.removeChild(img);

      const [ymin, xmin, ymax, xmax] = box_2d;
      const sx = (xmin / 1000) * full.width;
      const sy = (ymin / 1000) * full.height;
      const sw = Math.max(1, ((xmax - xmin) / 1000) * full.width);
      const sh = Math.max(1, ((ymax - ymin) / 1000) * full.height);

      const crop = (outW: number, outH: number) => {
        const c = document.createElement("canvas");
        c.width = outW; c.height = outH;
        const ctx = c.getContext("2d")!;
        ctx.imageSmoothingEnabled = true;
        ctx.imageSmoothingQuality = "high";
        ctx.drawImage(full, sx, sy, sw, sh, 0, 0, outW, outH);
        return c.toDataURL("image/jpeg", 0.92);
      };

      setThumbDataUrl(crop(sw, sh));
      setZoomDataUrl(crop(Math.round(sw * 3), Math.round(sh * 3)));
    };
    img.onerror = () => setError(true);
    img.src = imageUrl;
  }, [imageUrl, box_2d]);

  const handleMouseEnter = () => {
    if (containerRef.current) {
      setTooltipRect(containerRef.current.getBoundingClientRect());
    }
    setHovered(true);
  };

  if (error) {
    return (
      <div className="w-full h-full flex items-center justify-center bg-stone-50 text-[10px] font-mono text-rosebery-muted">
        Failed to load
      </div>
    );
  }

  return (
    <div
      ref={containerRef}
      className="relative w-full h-full cursor-zoom-in"
      onMouseEnter={handleMouseEnter}
      onMouseLeave={() => setHovered(false)}
    >
      {!thumbDataUrl ? (
        <div className="w-full h-full flex items-center justify-center bg-stone-50 text-[10px] font-mono text-rosebery-muted animate-pulse">
          Loading...
        </div>
      ) : (
        <img
          src={thumbDataUrl}
          alt={label}
          className="w-full h-full object-contain"
        />
      )}

      {/* Zoom tooltip: fixed position to the right of the evidence box */}
      {hovered && zoomDataUrl && tooltipRect && (
        <div
          className="fixed z-[9999] pointer-events-none"
          style={{
            left: tooltipRect.right + 12,
            top: tooltipRect.top,
          }}
        >
          <div className="bg-white border-2 border-rosebery-primary rounded-lg shadow-2xl overflow-hidden w-[340px]">
            <div className="bg-rosebery-primary px-3 py-1.5">
              <span className="text-[9px] font-mono text-white uppercase tracking-widest font-bold truncate block">
                🔍 {label}
              </span>
            </div>
            <img src={zoomDataUrl} alt={label} className="block w-full h-auto object-contain" />
          </div>
        </div>
      )}
    </div>
  );
}

export default function ReportView({ 
  report, 
  fileName, 
  fileSize, 
  imageUrl,
  supplementaryImages,
  onReAnalyze,
  isLoading,
  currency: propCurrency,
  setCurrency: propSetCurrency,
  onUpdateReport,
  userRole = "guest",
  curatorName
}: ReportViewProps) {
  const [localCurrency, setLocalCurrency] = React.useState<"USD" | "GBP" | "EUR">("USD");
  const currency = propCurrency || localCurrency;
  const setCurrency = propSetCurrency || setLocalCurrency;

  const [activeObsTab, setActiveObsTab] = React.useState<"authenticity" | "paper" | "dimensions" | "ink" | "inscriptions" | "defects">("authenticity");
  const [activeStageTab, setActiveStageTab] = React.useState<"summary" | "stage1" | "stage2" | "stage3">("summary");

  // Curation / Editing States
  const [isEditing, setIsEditing] = React.useState(false);
  const [editTitle, setEditTitle] = React.useState("");
  const [editArtist, setEditArtist] = React.useState("");
  const [editPeriod, setEditPeriod] = React.useState("");
  const [editArtistConfidence, setEditArtistConfidence] = React.useState(0);
  const [editTitleConfidence, setEditTitleConfidence] = React.useState(0);
  const [editIsReproduction, setEditIsReproduction] = React.useState(false);
  const [editReproductionExplanation, setEditReproductionExplanation] = React.useState("");
  const [editEditionSize, setEditEditionSize] = React.useState("");
  const [editLowEstimate, setEditLowEstimate] = React.useState(0);
  const [editHighEstimate, setEditHighEstimate] = React.useState(0);
  const [editValuationContext, setEditValuationContext] = React.useState("");
  const [editOverallGrade, setEditOverallGrade] = React.useState<'Poor' | 'Fair' | 'Good' | 'Excellent' | 'Mint'>('Good');
  const [editSignatureStatus, setEditSignatureStatus] = React.useState("");
  const [editMattingAndMargins, setEditMattingAndMargins] = React.useState("");
  const [editAnalysisDetails, setEditAnalysisDetails] = React.useState("");
  const [editVisualDescription, setEditVisualDescription] = React.useState("");
  const [editHistoricalContext, setEditHistoricalContext] = React.useState("");
  const [editInferredDimensions, setEditInferredDimensions] = React.useState("");
  const [editSignatureAnalysis, setEditSignatureAnalysis] = React.useState("");
  const [editDamageAnalysis, setEditDamageAnalysis] = React.useState("");

  const safeEst = (r: typeof report) => (r.auctionEstimate as any) || {};
  const safeCond = (r: typeof report) => (r.conditionNotes as any) || {};

  // Set document title to "AI Appraisal Outputs" while the print dialog is open
  React.useEffect(() => {
    const originalTitle = document.title;
    const onBefore = () => { document.title = "AI Appraisal Outputs"; };
    const onAfter  = () => { document.title = originalTitle; };
    window.addEventListener("beforeprint", onBefore);
    window.addEventListener("afterprint",  onAfter);
    return () => {
      window.removeEventListener("beforeprint", onBefore);
      window.removeEventListener("afterprint",  onAfter);
    };
  }, []);

  // Sync edit states when report changes
  React.useEffect(() => {
    const est = safeEst(report);
    const cond = safeCond(report);
    setEditTitle(report.artworkTitle);
    setEditArtist(report.likelyArtist);
    setEditPeriod(report.creationPeriod);
    setEditArtistConfidence(report.artistConfidence);
    setEditTitleConfidence(report.titleConfidence);
    setEditIsReproduction(report.isLikelyReproductionOrPoster);
    setEditReproductionExplanation(report.reproductionExplanation);
    setEditEditionSize(report.editionSizeAndPrintNumber || "");
    setEditLowEstimate(est.lowEstimate || 0);
    setEditHighEstimate(est.highEstimate || 0);
    setEditValuationContext(est.valuationContext || "");
    setEditOverallGrade(cond.overallGrade || "Good");
    setEditSignatureStatus(cond.signatureStatus || "");
    setEditMattingAndMargins(cond.mattingAndMargins || "");
    setEditAnalysisDetails(cond.analysisDetails || "");
    setEditVisualDescription(report.visualDescription);
    setEditHistoricalContext(report.historicalContext);
    setEditInferredDimensions(report.inferredDimensions || "");
    setEditSignatureAnalysis(report.signatureAnalysis || "");
    setEditDamageAnalysis(report.damageAnalysis || "");
  }, [report]);

  const handleCancel = () => {
    const est = safeEst(report);
    const cond = safeCond(report);
    setEditTitle(report.artworkTitle);
    setEditArtist(report.likelyArtist);
    setEditPeriod(report.creationPeriod);
    setEditArtistConfidence(report.artistConfidence);
    setEditTitleConfidence(report.titleConfidence);
    setEditIsReproduction(report.isLikelyReproductionOrPoster);
    setEditReproductionExplanation(report.reproductionExplanation);
    setEditEditionSize(report.editionSizeAndPrintNumber || "");
    setEditLowEstimate(est.lowEstimate || 0);
    setEditHighEstimate(est.highEstimate || 0);
    setEditValuationContext(est.valuationContext || "");
    setEditOverallGrade(cond.overallGrade || "Good");
    setEditSignatureStatus(cond.signatureStatus || "");
    setEditMattingAndMargins(cond.mattingAndMargins || "");
    setEditAnalysisDetails(cond.analysisDetails || "");
    setEditVisualDescription(report.visualDescription);
    setEditHistoricalContext(report.historicalContext);
    setEditInferredDimensions(report.inferredDimensions || "");
    setEditSignatureAnalysis(report.signatureAnalysis || "");
    setEditDamageAnalysis(report.damageAnalysis || "");
    setIsEditing(false);
  };

  const handleSave = () => {
    if (onUpdateReport) {
      const baseCurrency = safeEst(report).currency || "USD";
      
      let finalModel = report.modelUsed || "gemini-2.5-flash";
      const editedIndex = finalModel.indexOf(" (Edited by");
      if (editedIndex !== -1) {
        finalModel = finalModel.substring(0, editedIndex);
      }
      if (userRole === "curator") {
        finalModel = `${finalModel} (Edited by ${curatorName || "Curator"})`;
      }

      const updatedReport: PrintAnalysisReport = {
        ...report,
        artworkTitle: editTitle,
        likelyArtist: editArtist,
        creationPeriod: editPeriod,
        artistConfidence: editArtistConfidence,
        titleConfidence: editTitleConfidence,
        isLikelyReproductionOrPoster: editIsReproduction,
        reproductionExplanation: editReproductionExplanation,
        editionSizeAndPrintNumber: editEditionSize || undefined,
        modelUsed: finalModel,
        auctionEstimate: {
          ...(typeof report.auctionEstimate === "object" && report.auctionEstimate !== null ? report.auctionEstimate : { currency: baseCurrency }),
          lowEstimate: editLowEstimate,
          highEstimate: editHighEstimate,
          valuationContext: editValuationContext,
          formattedEstimate: `${getCurrencySymbol(baseCurrency)}${editLowEstimate.toLocaleString()} - ${getCurrencySymbol(baseCurrency)}${editHighEstimate.toLocaleString()} ${baseCurrency}`
        },
        conditionNotes: {
          ...report.conditionNotes,
          overallGrade: editOverallGrade,
          signatureStatus: editSignatureStatus,
          mattingAndMargins: editMattingAndMargins,
          analysisDetails: editAnalysisDetails,
        },
        visualDescription: editVisualDescription,
        historicalContext: editHistoricalContext,
        inferredDimensions: editInferredDimensions || undefined,
        signatureAnalysis: editSignatureAnalysis || undefined,
        damageAnalysis: editDamageAnalysis || undefined,
      };
      onUpdateReport(updatedReport);
    }
    setIsEditing(false);
  };

  // Currency Conversion Helpers
  const convertValue = (val: number, from: string, to: string): number => {
    if (!from || !to || from.toUpperCase() === to.toUpperCase()) return val;
    
    let valInUSD = val;
    const origin = from.toUpperCase();
    const target = to.toUpperCase();
    
    // Convert to base USD
    if (origin === "GBP") {
      valInUSD = val * 1.25;
    } else if (origin === "EUR") {
      valInUSD = val * 1.09;
    }
    
    // Convert from USD to target
    if (target === "USD") {
      return Math.round(valInUSD);
    } else if (target === "GBP") {
      return Math.round(valInUSD * 0.80);
    } else if (target === "EUR") {
      return Math.round(valInUSD * 0.92);
    }
    
    return val;
  };

  const getCurrencySymbol = (code: string) => {
    if (code === "USD") return "$";
    if (code === "GBP") return "£";
    if (code === "EUR") return "€";
    return "";
  };

  const formatAndConvertPriceRealized = (priceStr: string, targetCurrency: string) => {
    if (!priceStr) return "—";
    // If the string contains non-numeric text beyond a currency marker, return it as-is
    // to avoid mangling values like "Not specified" or "estimate 200-250 USD"
    const looksLikePrice = /^[\$£€]?\s*[\d,]+|[\d,]+\s*(USD|GBP|EUR)$/i.test(priceStr.trim());
    if (!looksLikePrice) return priceStr;
    
    // Find all currency figures in the string using regex, e.g. "$12,000" or "£10,000" or "€55,200"
    // and replace them with converted figures in-place!
    const regex = /(?:USD|GBP|EUR|\$|£|€)\s*[\d,]+|[\d,]+\s*(?:USD|GBP|EUR)/gi;
    const foundMatches = priceStr.match(regex);
    
    if (foundMatches) {
      let result = priceStr;
      for (const m of foundMatches) {
        const digits = m.replace(/[^0-9]/g, "");
        if (!digits) continue;
        const val = parseInt(digits, 10);
        
        let origCur = "USD";
        if (m.includes("GBP") || m.includes("£")) {
          origCur = "GBP";
        } else if (m.includes("EUR") || m.includes("€")) {
          origCur = "EUR";
        }
        
        if (origCur.toUpperCase() !== targetCurrency.toUpperCase()) {
          const converted = convertValue(val, origCur, targetCurrency);
          const formatted = `${getCurrencySymbol(targetCurrency)}${converted.toLocaleString()} ${targetCurrency}`;
          result = result.replace(m, formatted);
        }
      }
      return result;
    }
    
    const digitsOnly = priceStr.replace(/[^0-9]/g, "");
    if (!digitsOnly) return priceStr;
    const originalValue = parseInt(digitsOnly, 10);
    
    let originalCurrency = "USD";
    if (priceStr.includes("GBP") || priceStr.includes("£")) {
      originalCurrency = "GBP";
    } else if (priceStr.includes("EUR") || priceStr.includes("€")) {
      originalCurrency = "EUR";
    }
    
    if (originalCurrency.toUpperCase() === targetCurrency.toUpperCase()) return priceStr;
    
    const converted = convertValue(originalValue, originalCurrency, targetCurrency);
    return `${getCurrencySymbol(targetCurrency)}${converted.toLocaleString()} ${targetCurrency}`;
  };

  // Determine Grade Badge color
  const getGradeStyle = (grade: string) => {
    switch (grade) {
      case "Mint":
        return "bg-teal-50 border-teal-200 text-teal-800";
      case "Excellent":
        return "bg-emerald-50 border-emerald-200 text-emerald-800";
      case "Good":
        return "bg-amber-50 border-amber-200 text-amber-800";
      case "Fair":
        return "bg-orange-50 border-orange-200 text-orange-800";
      default: // Poor
        return "bg-rose-50 border-rose-200 text-rose-800";
    }
  };

  // Reusable Valuation Panel
  const renderValuationPanel = () => (
    <div className="grid grid-cols-1 lg:grid-cols-3 gap-8 animate-fadeIn">
      <div className="lg:col-span-1 bg-white border border-rosebery-border rounded-xl p-6 shadow-gallery-soft flex flex-col justify-between">
        <div>
          <div className="flex items-start justify-between gap-2 mb-4">
            <span className="text-xs font-mono tracking-[0.2em] text-rosebery-primary uppercase flex items-center gap-1.5 font-bold mt-1">
              <Coins className="w-4 h-4 text-rosebery-primary" />
              ESTIMATED MARKET VALUATION
            </span>
            {/* Compact currency selector in the right corner */}
            <div className="flex border border-rosebery-border rounded-sm overflow-hidden text-[10px] font-mono shadow-xs shrink-0 bg-stone-50">
              {(["USD", "GBP", "EUR"] as const).map((curr) => (
                <button
                  key={curr}
                  type="button"
                  onClick={() => setCurrency(curr)}
                  className={`px-2 py-1 font-bold transition-colors cursor-pointer ${
                    currency === curr
                      ? "bg-rosebery-primary text-white"
                      : "text-rosebery-muted hover:text-rosebery-primary hover:bg-[#E8E2D7]/20"
                  }`}
                >
                  {curr}
                </button>
              ))}
            </div>
          </div>
          <h3 className="text-xs font-sans font-medium text-rosebery-muted uppercase tracking-wider block">AUCTION VALUE RANGE</h3>
          {isEditing ? (
            <div className="space-y-3 my-4">
              <div className="grid grid-cols-2 gap-3">
                <div className="space-y-1">
                  <label className="text-[9px] font-mono text-rosebery-muted uppercase">Low ({safeEst(report).currency || "USD"})</label>
                  <input
                    type="number"
                    value={editLowEstimate}
                    onChange={(e) => setEditLowEstimate(parseInt(e.target.value) || 0)}
                    className="w-full bg-rosebery-sage border border-rosebery-sage-border focus:border-rosebery-primary focus:ring-1 focus:ring-rosebery-primary/20 rounded-sm px-2.5 py-1 text-sm font-bold text-rosebery-primary focus:outline-none"
                  />
                </div>
                <div className="space-y-1">
                  <label className="text-[9px] font-mono text-rosebery-muted uppercase">High ({safeEst(report).currency || "USD"})</label>
                  <input
                    type="number"
                    value={editHighEstimate}
                    onChange={(e) => setEditHighEstimate(parseInt(e.target.value) || 0)}
                    className="w-full bg-rosebery-sage border border-rosebery-sage-border focus:border-rosebery-primary focus:ring-1 focus:ring-rosebery-primary/20 rounded-sm px-2.5 py-1 text-sm font-bold text-rosebery-primary focus:outline-none"
                  />
                </div>
              </div>
            </div>
          ) : (
            <div className="my-5">
              <span className="text-2xl md:text-3xl font-serif font-bold tracking-wide text-rosebery-primary block">
                {(safeEst(report).lowEstimate || 0) === 0
                  ? "speculative value"
                  : `${getCurrencySymbol(currency)}${convertValue(safeEst(report).lowEstimate, safeEst(report).currency || "USD", currency).toLocaleString()} - ${getCurrencySymbol(currency)}${convertValue(safeEst(report).highEstimate, safeEst(report).currency || "USD", currency).toLocaleString()} ${currency}`}
              </span>
              <p className="text-xs font-mono text-rosebery-primary font-semibold mt-2.5">
                ESTIMATED IN GLOBAL CURRENCY MARKET ({currency})
              </p>
            </div>
          )}
        </div>
        
        <div className="bg-stone-50 border border-rosebery-border p-4 rounded mt-4 flex-1">
          <span className="text-xs font-mono text-rosebery-primary font-semibold uppercase tracking-widest block mb-1.5">Auction Market Context</span>
          {isEditing ? (
            <textarea
              value={editValuationContext}
              onChange={(e) => setEditValuationContext(e.target.value)}
              rows={3}
              className="w-full bg-rosebery-sage border border-rosebery-sage-border focus:border-rosebery-primary focus:ring-1 focus:ring-rosebery-primary/20 rounded-sm p-2 text-xs text-rosebery-text-normal focus:outline-none"
              placeholder="Market context details..."
            />
          ) : (
            <p className="text-xs text-rosebery-muted leading-relaxed">
              {safeEst(report).valuationContext || ""}
            </p>
          )}
        </div>
      </div>

      <div className="lg:col-span-2 bg-white border border-rosebery-border rounded-xl p-6 shadow-gallery-soft flex flex-col justify-between">
        <div>
          <span className="text-xs font-mono tracking-[0.2em] text-rosebery-primary uppercase flex items-center gap-2 mb-4 font-bold">
            <Clipboard className="w-4 h-4" />
            DETAILED CONDITION RECAP & NOTES
          </span>

          <div className="flex flex-wrap items-center gap-6 mb-5 border-b border-rosebery-border pb-5">
            <div>
              <span className="text-xs text-rosebery-muted block mb-1">Preservation Grading</span>
              {isEditing ? (
                <select
                  value={editOverallGrade}
                  onChange={(e) => setEditOverallGrade(e.target.value as any)}
                  className="bg-rosebery-sage border border-rosebery-sage-border focus:border-rosebery-primary focus:ring-1 focus:ring-rosebery-primary/20 rounded-sm px-2 py-1 text-xs font-bold text-rosebery-primary focus:outline-none cursor-pointer"
                >
                  <option value="Mint">Mint</option>
                  <option value="Excellent">Excellent</option>
                  <option value="Good">Good</option>
                  <option value="Fair">Fair</option>
                  <option value="Poor">Poor</option>
                </select>
              ) : (
                <span className={`inline-flex items-center px-3 py-1 rounded border text-xs font-bold uppercase tracking-wider ${getGradeStyle(safeCond(report).overallGrade)}`}>
                  ★ {safeCond(report).overallGrade || "N/A"} Grade
                </span>
              )}
            </div>
            
            <div className="flex-1 min-w-[200px]">
              <span className="text-xs text-rosebery-muted block mb-1">Plate Ink / Border Signature</span>
              {isEditing ? (
                <input
                  type="text"
                  value={editSignatureStatus}
                  onChange={(e) => setEditSignatureStatus(e.target.value)}
                  className="w-full bg-rosebery-sage border border-rosebery-sage-border focus:border-rosebery-primary focus:ring-1 focus:ring-rosebery-primary/20 rounded-sm px-2.5 py-1 text-xs font-semibold text-rosebery-charcoal focus:outline-none"
                />
              ) : (
                <span className="text-xs font-semibold text-rosebery-charcoal block">
                  {safeCond(report).signatureStatus || ""}
                </span>
              )}
            </div>
          </div>

          <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
            <div>
              <span className="text-[10px] font-mono tracking-widest text-rosebery-primary uppercase block mb-2.5 font-bold">VISIBLE SURFACE IRREGULARITIES</span>
              {(safeCond(report).issuesDetected || []).length === 0 || ((safeCond(report).issuesDetected || []).length === 1 && safeCond(report).issuesDetected[0].toLowerCase().includes("no obvious")) ? (
                <div className="flex items-center gap-2 text-xs text-emerald-800 bg-emerald-50 border border-emerald-200 p-3 rounded">
                  <CheckCircle2 className="w-4 h-4 shrink-0 text-emerald-600" />
                  No high-risk environmental stains or tears observed in photography.
                </div>
              ) : (
                <ul className="space-y-1.5">
                  {(safeCond(report).issuesDetected || []).map((issue: string, idx: number) => (
                    <li key={idx} className="flex items-start gap-2 text-xs text-rosebery-muted">
                      <span className="text-rosebery-primary font-bold mt-0.5 shrink-0">•</span>
                      <span>{issue}</span>
                    </li>
                  ))}
                </ul>
              )}
            </div>

            <div className="space-y-4">
              <div>
                <span className="text-[10px] font-mono tracking-widest text-rosebery-primary uppercase block mb-2 font-bold">PRESENTATION & SHEET EDGE</span>
                {isEditing ? (
                  <textarea
                    value={editMattingAndMargins}
                    onChange={(e) => setEditMattingAndMargins(e.target.value)}
                    rows={3}
                    className="w-full bg-rosebery-sage border border-rosebery-sage-border focus:border-rosebery-primary focus:ring-1 focus:ring-rosebery-primary/20 rounded-sm p-2 text-xs text-rosebery-text-normal focus:outline-none"
                    placeholder="Matting and margins notes..."
                  />
                ) : (
                  <p className="text-xs text-rosebery-muted leading-relaxed">
                    {safeCond(report).mattingAndMargins || ""}
                  </p>
                )}
              </div>
              
              <div className="bg-stone-50 border border-rosebery-border p-3 rounded">
                <span className="text-[10px] font-mono text-rosebery-primary font-semibold uppercase block mb-1">APPRAISER ANNOTATION</span>
                {isEditing ? (
                  <textarea
                    value={editAnalysisDetails}
                    onChange={(e) => setEditAnalysisDetails(e.target.value)}
                    rows={3}
                    className="w-full bg-rosebery-sage border border-rosebery-sage-border focus:border-rosebery-primary focus:ring-1 focus:ring-rosebery-primary/20 rounded-sm p-2 text-xs text-rosebery-text-normal focus:outline-none"
                    placeholder="Analysis details..."
                  />
                ) : (
                  <p className="text-xs text-rosebery-muted leading-relaxed">
                    {safeCond(report).analysisDetails || ""}
                  </p>
                )}
              </div>
            </div>
          </div>
        </div>
      </div>
    </div>
  );

  // Reusable Conservator Recommendations Card
  const renderConservatorRecommendations = () => (
    <div className="bg-stone-50 border border-rosebery-border text-rosebery-text-normal rounded-xl p-6 md:p-8 shadow-gallery-soft animate-fadeIn">
      <div className="flex items-center gap-2.5 border-b border-rosebery-border pb-4 mb-5">
        <Award className="w-5 h-5 text-rosebery-primary shrink-0" />
        <div>
          <h4 className="text-md font-serif font-semibold text-rosebery-charcoal tracking-wide uppercase">ARCHIVAL CARE RECOMMENDATIONS</h4>
          <span className="text-[9px] font-mono text-rosebery-primary font-semibold uppercase tracking-[0.25em] block mt-0.5">
            PRESERVING AND AUTHENTICATING HAND-PULLED GRAPHICS
          </span>
        </div>
      </div>

      <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
        <div className="space-y-4 font-sans">
          <p className="text-xs leading-relaxed text-rosebery-muted">
            Hand-pulled prints are printed on reactive organic fiber sheets (such as cotton linen rag or traditional mulberry washi webs). They are fragile to temperature swings, direct raw sunlight waves, and permanent hinge binders.
          </p>
          <div className="bg-white p-4 rounded border border-rosebery-border">
            <span className="text-[10px] font-mono text-rosebery-primary block mb-1 font-bold">CRUCIAL CURATOR MANDATE</span>
            <p className="text-[11px] text-rosebery-muted italic leading-relaxed">
              Never trim paper borders or clean surface marks yourself! Trimming graphic print margins reduces market value by up to 50% as boundaries carry critical watermark details or cataloger pencil notations.
            </p>
          </div>
        </div>

        <div className="space-y-3 font-sans">
          <span className="text-xs font-mono text-rosebery-primary uppercase tracking-wider block font-bold">RECOMMENDED PRESERVATION STRATEGY</span>
          <ul className="space-y-2.5 text-xs">
            {report.nextSteps.map((rec, index) => (
              <li key={index} className="flex items-start gap-2.5">
                <span className="flex items-center justify-center bg-white text-rosebery-primary rounded-full w-4.5 h-4.5 shrink-0 font-sans text-[10px] font-bold border border-rosebery-border">
                  {index + 1}
                </span>
                <span className="text-rosebery-muted leading-relaxed">{rec}</span>
              </li>
            ))}
          </ul>
        </div>
      </div>
    </div>
  );

  return (
    <>
    <div id="art-report-view" className="space-y-8 animate-fadeIn text-rosebery-text-normal print:hidden">
      {/* Sleek Curation Bar */}
      <div className="flex justify-between items-center bg-rosebery-card border border-rosebery-border rounded-sm px-5 py-3 shadow-xs">
        <div className="flex items-center gap-2">
          <span className="bg-rosebery-primary text-white p-1.5 rounded-sm">
            <Clipboard className="w-4 h-4" />
          </span>
          <div>
            <span className="text-[10px] font-mono text-rosebery-primary uppercase tracking-wider font-semibold block">
              REPORT CURATION MODE
            </span>
            <span className="text-[11px] text-rosebery-muted font-serif">
              {isEditing ? "Curating appraisal overrides..." : "Professional Art Appraiser Review"}
            </span>
          </div>
        </div>
        
        <div className="flex items-center gap-2">
          {isEditing ? (
            <>
              <button
                type="button"
                onClick={handleCancel}
                className="text-xs text-rosebery-muted hover:text-rosebery-primary font-bold flex items-center gap-1.5 border border-rosebery-border hover:bg-rosebery-cream-bg px-4 py-2 rounded-sm transition-all cursor-pointer bg-white font-mono uppercase tracking-wider"
              >
                Cancel
              </button>
              <button
                type="button"
                onClick={handleSave}
                className="text-xs text-white bg-rosebery-primary hover:bg-rosebery-primary-hover font-bold flex items-center gap-1.5 border border-rosebery-primary px-4 py-2 rounded-sm transition-all cursor-pointer font-mono uppercase tracking-wider shadow-gallery-soft"
              >
                Save Curation
              </button>
            </>
          ) : (
            <div className="flex gap-2">
              {(userRole === "admin" || userRole === "curator") && (
                <button
                  type="button"
                  onClick={() => setIsEditing(true)}
                  className="text-xs text-rosebery-primary hover:text-white font-bold flex items-center gap-1.5 border border-rosebery-primary hover:bg-rosebery-primary px-4 py-2 rounded-sm transition-all cursor-pointer bg-transparent font-mono uppercase tracking-wider"
                >
                  Edit Report
                </button>
              )}
              <button
                type="button"
                onClick={() => window.print()}
                className="text-xs text-rosebery-primary hover:text-white font-bold flex items-center gap-1.5 border border-rosebery-primary hover:bg-rosebery-primary px-4 py-2 rounded-sm transition-all cursor-pointer bg-transparent font-mono uppercase tracking-wider flex items-center gap-1"
              >
                <FileText className="w-3.5 h-3.5" />
                Export PDF
              </button>
            </div>
          )}
        </div>
      </div>

      {/* Premium Pipeline Stage Timeline */}
      <div className="bg-rosebery-card border border-rosebery-border rounded-xl p-6 shadow-gallery-soft select-none animate-fadeIn">
        <div className="flex flex-col md:flex-row items-center justify-between gap-4">
          <div className="flex items-center gap-2">
            <span className="bg-rosebery-primary text-white p-1.5 rounded-sm">
              <Compass className="w-4.5 h-4.5" />
            </span>
            <div>
              <span className="text-[10px] font-mono text-rosebery-primary uppercase tracking-widest font-semibold block leading-none">
                PIPELINE APPRAISAL WORKFLOW
              </span>
              <span className="text-[11px] text-rosebery-muted font-serif">
                Select a stage below to inspect detailed data points
              </span>
            </div>
          </div>
          
          <div className="flex items-center gap-2 sm:gap-3 overflow-x-auto w-full md:w-auto justify-end py-1">
            {[
              { id: "summary", step: "Summary", label: "Executive Report" },
              { id: "stage1", step: "Stage 1", label: "Visual Extraction" },
              { id: "stage2", step: "Stage 2", label: "Attribution & Editions" },
              { id: "stage3", step: "Stage 3", label: "Valuation & Context" }
            ].map((stage, idx) => (
              <button
                key={stage.id}
                type="button"
                onClick={() => setActiveStageTab(stage.id as any)}
                className={`flex items-center gap-2 px-3 py-2 rounded border text-xs font-semibold cursor-pointer transition-all shrink-0 ${
                  activeStageTab === stage.id
                    ? "bg-rosebery-primary border-rosebery-primary text-white shadow-gallery-soft"
                    : "bg-white border-rosebery-border text-rosebery-muted hover:border-rosebery-primary hover:text-rosebery-primary"
                }`}
              >
                <span className={`flex items-center justify-center rounded-full w-5 h-5 text-[10px] font-bold ${
                  activeStageTab === stage.id ? "bg-white text-rosebery-primary" : "bg-stone-100 text-rosebery-muted"
                }`}>
                  {idx + 1}
                </span>
                <div className="text-left font-mono">
                  <span className="block text-[8px] uppercase tracking-wider leading-none text-opacity-80">{stage.step}</span>
                  <span className="block text-[11px] leading-tight font-serif mt-0.5">{stage.label}</span>
                </div>
              </button>
            ))}
          </div>
        </div>
      </div>

      {/* Early Halt / Reproduction Warning Banner */}
      {(report.isLikelyReproductionOrPoster || report.stage1Result?.imageAuthenticity?.haltRecommended) && (
        <div className="bg-rose-50 border-l-4 border-l-rosebery-primary border border-rosebery-border p-5 rounded-lg flex items-start gap-4 shadow-sm animate-fadeIn">
          <ShieldAlert className="w-6 h-6 text-rosebery-primary shrink-0 mt-0.5" />
          <div className="space-y-1">
            <h4 className="text-sm font-semibold text-rosebery-charcoal uppercase tracking-wider font-mono">
              POTENTIAL DIGITAL REPRODUCTION OR POSTER DETECTED
            </h4>
            <p className="text-xs text-rosebery-text-normal leading-relaxed">
              {report.reproductionExplanation || report.stage1Result?.imageAuthenticity?.haltReason || "The system has flagged this image as a potential digital reproduction, catalog screenshot, or poster print. Automatic valuation has been restricted to protect appraisal integrity."}
            </p>
            {report.stage1Result?.imageAuthenticity?.reproductionIndicatorsFound && report.stage1Result.imageAuthenticity.reproductionIndicatorsFound.length > 0 && (
              <div className="mt-3 pt-3 border-t border-rosebery-border">
                <span className="text-[10px] font-mono text-rosebery-primary uppercase tracking-wider font-bold block mb-1.5">
                  Detection Flags:
                </span>
                <ul className="space-y-1 text-xs">
                  {report.stage1Result.imageAuthenticity.reproductionIndicatorsFound.map((ind, i) => (
                    <li key={i} className="text-rosebery-muted flex items-start gap-1.5">
                      <span className="text-rosebery-primary font-bold">•</span>
                      <span><strong>{ind.indicator}</strong>: {ind.description}</span>
                    </li>
                  ))}
                </ul>
              </div>
            )}
          </div>
        </div>
      )}

      {/* ----------------- TAB 1: EXECUTIVE SUMMARY ----------------- */}
      {activeStageTab === "summary" && (
        <>
          {/* Overview Card */}
          <div className="bg-white border border-rosebery-border rounded-xl p-6 md:p-8 shadow-gallery-soft">
            <div className="flex flex-col lg:flex-row justify-between gap-6 border-b border-rosebery-border pb-6 mb-6">
              <div className="flex-1 space-y-4">
                <div>
                  <span className="text-xs font-mono tracking-[0.25em] text-rosebery-primary uppercase font-bold block mb-1">
                    ESTABLISHED EXHIBITION RECORD
                  </span>
                  {isEditing ? (
                    <div className="space-y-1">
                      <label className="text-[10px] font-mono text-rosebery-primary uppercase tracking-wider font-semibold block">Artwork Title</label>
                      <input
                        type="text"
                        value={editTitle}
                        onChange={(e) => setEditTitle(e.target.value)}
                        className="w-full bg-rosebery-sage border border-rosebery-sage-border focus:border-rosebery-primary focus:ring-1 focus:ring-rosebery-primary/20 rounded-sm px-3 py-1.5 text-base font-serif text-rosebery-charcoal focus:outline-none"
                      />
                    </div>
                  ) : (
                    <h2 className="text-2xl md:text-3xl font-serif text-rosebery-charcoal font-semibold tracking-wide leading-none">
                      {report.artworkTitle}
                    </h2>
                  )}

                  {isEditing ? (
                    <div className="space-y-1 mt-2.5">
                      <label className="text-[10px] font-mono text-rosebery-primary uppercase tracking-wider font-semibold block">Likely Artist</label>
                      <div className="relative">
                        <User className="w-4 h-4 absolute left-3 top-2.5 text-rosebery-primary" />
                        <input
                          type="text"
                          value={editArtist}
                          onChange={(e) => setEditArtist(e.target.value)}
                          className="w-full bg-rosebery-sage border border-rosebery-sage-border focus:border-rosebery-primary focus:ring-1 focus:ring-rosebery-primary/20 rounded-sm pl-9 pr-3 py-1.5 text-sm font-sans font-semibold text-rosebery-primary focus:outline-none"
                        />
                      </div>
                    </div>
                  ) : (
                    <p className="text-md text-rosebery-muted mt-2 font-serif italic flex items-center gap-2">
                      <User className="w-4 h-4 inline text-rosebery-primary" />
                      attributed to <span className="font-sans font-semibold text-rosebery-primary not-italic">{report.likelyArtist}</span>
                    </p>
                  )}
                </div>
                
                <div className="space-y-2.5">
                  <div className="flex flex-wrap gap-2.5 items-center">
                    {fileName && (
                      <span className="text-[11px] font-mono bg-rosebery-cream-bg border border-rosebery-border px-3 py-1.5 rounded-full text-rosebery-muted">
                        Scan File: <span className="text-rosebery-charcoal font-semibold">{fileName}</span> {fileSize ? `(${fileSize})` : ""}
                      </span>
                    )}
                    {isEditing ? (
                      <div className="space-y-1">
                        <label className="text-[10px] font-mono text-rosebery-primary uppercase tracking-wider font-semibold block">Creation Period</label>
                        <input
                          type="text"
                          value={editPeriod}
                          onChange={(e) => setEditPeriod(e.target.value)}
                          className="bg-rosebery-sage border border-rosebery-sage-border focus:border-rosebery-primary focus:ring-1 focus:ring-rosebery-primary/20 text-xs font-mono text-rosebery-charcoal px-3.5 py-1.5 rounded-sm focus:outline-none"
                        />
                      </div>
                    ) : (
                      <span className="text-xs font-mono bg-rosebery-primary text-white px-3.5 py-1.5 rounded-sm font-semibold uppercase tracking-wider">
                        {report.creationPeriod}
                      </span>
                    )}
                  </div>
                  
                  {(report.modelUsed || report.promptVersion) && (
                    <div className="text-[11px] font-mono text-rosebery-muted pl-1">
                      Appraisal Method: <span className="text-rosebery-charcoal font-semibold">{resolveMethodLabel(report.promptVersion || "standard", report.modelUsed || "")}</span>
                    </div>
                  )}
                </div>
              </div>

              {imageUrl && (
                <div className="shrink-0 lg:max-w-[220px] w-full flex justify-center lg:justify-end">
                  <div className="relative group">
                    <div className="absolute -inset-0.5 bg-gradient-to-r from-[#4C0B2A] to-[#8E7950] opacity-20 blur-xs rounded-sm"></div>
                    <div className="relative bg-stone-50 p-2 border border-rosebery-border shadow-gallery-soft rounded-sm">
                      <img 
                        src={imageUrl} 
                        alt={report.artworkTitle}
                        className="max-h-[140px] w-auto object-contain rounded-sm"
                      />
                    </div>
                  </div>
                </div>
              )}
            </div>

            {/* Confidence Grid and Key Findings */}
            <div className="grid grid-cols-1 md:grid-cols-3 gap-6">
              {/* Artist Confidence Card */}
              <div className="bg-stone-50 border border-rosebery-border p-5 rounded-lg shadow-xs">
                <span className="text-[10px] font-mono text-rosebery-muted uppercase tracking-widest block mb-2 font-semibold">Artist Attribution Probability</span>
                {isEditing ? (
                  <div className="space-y-2">
                    <input
                      type="range"
                      min="0"
                      max="100"
                      value={editArtistConfidence}
                      onChange={(e) => setEditArtistConfidence(parseInt(e.target.value) || 0)}
                      className="w-full accent-[#4C0B2A]"
                    />
                    <div className="flex justify-between text-xs font-mono">
                      <span>Confidence:</span>
                      <span className="font-bold text-rosebery-primary">{editArtistConfidence}%</span>
                    </div>
                  </div>
                ) : (
                  <>
                    <div className="flex items-baseline gap-2">
                      <span className="text-3xl font-bold text-rosebery-charcoal font-serif">{report.artistConfidence}%</span>
                      <span className="text-xs font-mono text-rosebery-primary font-semibold">confident</span>
                    </div>
                    <div className="w-full bg-[#E8E2D7] h-1.5 rounded-full mt-3 overflow-hidden">
                      <div 
                        className="bg-rosebery-primary h-full rounded-full transition-all duration-500" 
                        style={{ width: `${report.artistConfidence}%` }}
                      />
                    </div>
                  </>
                )}
                <p className="text-xs text-rosebery-muted mt-3 leading-relaxed">
                  Based on stylistic cataloging, composition weight, color pigments, and inscription fidelity.
                </p>
              </div>

              {/* Title Identification Card */}
              <div className="bg-stone-50 border border-rosebery-border p-5 rounded-lg shadow-xs">
                <span className="text-[10px] font-mono text-rosebery-muted uppercase tracking-widest block mb-1 font-semibold">Catalogue Raisonné Match</span>
                {isEditing ? (
                  <div className="space-y-2">
                    <input
                      type="range"
                      min="0"
                      max="100"
                      value={editTitleConfidence}
                      onChange={(e) => setEditTitleConfidence(parseInt(e.target.value) || 0)}
                      className="w-full accent-[#4C0B2A]"
                    />
                    <div className="flex justify-between text-xs font-mono">
                      <span>Compatibility:</span>
                      <span className="font-bold text-rosebery-primary">{editTitleConfidence}%</span>
                    </div>
                  </div>
                ) : (
                  <>
                    <div className="flex items-baseline gap-2 mt-1">
                      <span className="text-3xl font-bold text-rosebery-charcoal font-serif">{report.titleConfidence}%</span>
                      <span className="text-xs font-mono text-rosebery-primary font-semibold font-bold">compatibility</span>
                    </div>
                    <div className="w-full bg-[#E8E2D7] h-1.5 rounded-full mt-3 overflow-hidden">
                      <div 
                        className="bg-rosebery-primary h-full rounded-full transition-all duration-500" 
                        style={{ width: `${report.titleConfidence}%` }}
                      />
                    </div>
                  </>
                )}
                <p className="text-xs text-rosebery-muted mt-3 leading-relaxed">
                  Comparison made with known registry dimensions, published states, and design elements.
                </p>
              </div>

              {/* Originality indicator */}
              <div className={`p-5 rounded-lg border shadow-xs ${
                isEditing
                  ? "bg-stone-50 border-rosebery-border text-rosebery-text-normal"
                  : report.isLikelyReproductionOrPoster 
                    ? "bg-amber-50 border-amber-200 text-amber-800" 
                    : "bg-emerald-50 border-emerald-200 text-emerald-800"
              }`}>
                <span className="text-xs font-mono uppercase tracking-widest block mb-2 flex items-center gap-1.5 font-bold text-rosebery-primary">
                  <ShieldAlert className="w-3.5 h-3.5" />
                  Originality Check
                </span>
                {isEditing ? (
                  <div className="space-y-3">
                    <label className="flex items-center gap-2 text-xs font-semibold cursor-pointer">
                      <input
                        type="checkbox"
                        checked={editIsReproduction}
                        onChange={(e) => setEditIsReproduction(e.target.checked)}
                        className="rounded border-rosebery-border text-rosebery-primary focus:ring-rosebery-primary w-4 h-4 cursor-pointer"
                      />
                      <span>Likely Reproduction / Poster Scan</span>
                    </label>
                    <textarea
                      value={editReproductionExplanation}
                      onChange={(e) => setEditReproductionExplanation(e.target.value)}
                      rows={2}
                      className="w-full bg-rosebery-sage border border-rosebery-sage-border focus:border-rosebery-primary focus:ring-1 focus:ring-rosebery-primary/20 rounded-sm p-2 text-xs font-sans text-rosebery-text-normal focus:outline-none"
                      placeholder="Explain why it is or is not a reproduction..."
                    />
                  </div>
                ) : (
                  <>
                    <div className="flex items-baseline gap-1">
                      <span className="text-lg font-bold font-serif text-rosebery-charcoal">
                        {report.isLikelyReproductionOrPoster ? "Speculative / Modern Scan" : "Authentic Fine Art Print"}
                      </span>
                    </div>
                    <p className="text-xs mt-3 leading-relaxed text-rosebery-muted">
                      {report.reproductionExplanation}
                    </p>
                  </>
                )}
              </div>
            </div>

            {/* Edition & Printing Number Details Block */}
            {(isEditing || report.editionSizeAndPrintNumber) && (
              <div className="bg-stone-50 border border-rosebery-border p-5 rounded-lg shadow-xs flex flex-col md:flex-row items-start md:items-center gap-4 border-l-4 border-l-[#4C0B2A] mt-6">
                <div className="bg-rosebery-primary text-white p-2.5 rounded-sm shrink-0">
                  <Hash className="w-5 h-5" />
                </div>
                <div className="space-y-1 flex-1">
                  <span className="text-[10px] font-mono uppercase tracking-widest text-rosebery-primary font-bold block">
                    Edition Size & Print Numbering Information
                  </span>
                  {isEditing ? (
                    <input
                      type="text"
                      value={editEditionSize}
                      onChange={(e) => setEditEditionSize(e.target.value)}
                      placeholder="e.g. 45 / 100, Artists Proof, Unlimited Open Edition"
                      className="w-full bg-rosebery-sage border border-rosebery-sage-border focus:border-rosebery-primary focus:ring-1 focus:ring-rosebery-primary/20 rounded-sm px-3 py-1.5 text-xs font-serif italic text-rosebery-charcoal focus:outline-none"
                    />
                  ) : (
                    <p className="text-xs text-rosebery-charcoal font-serif italic leading-relaxed">
                      {typeof report.editionSizeAndPrintNumber === "object" ? Object.values(report.editionSizeAndPrintNumber as any).filter(Boolean).join(", ") : report.editionSizeAndPrintNumber}
                    </p>
                  )}
                </div>
              </div>
            )}
          </div>

          {/* Valuation Panel */}
          {renderValuationPanel()}

          {/* Benchmark Comps — compact summary view */}
          {report.recentAuctionSales && report.recentAuctionSales.length > 0 && (
            <div className="bg-white border border-rosebery-border rounded-xl p-6 shadow-gallery-soft space-y-3 animate-fadeIn">
              <div className="flex items-center justify-between border-b border-rosebery-border pb-3">
                <span className="text-xs font-mono tracking-[0.2em] text-rosebery-primary uppercase flex items-center gap-2 font-bold">
                  <Coins className="w-4 h-4 text-rosebery-primary" />
                  RECENT BENCHMARK SALES
                </span>
                <button
                  onClick={() => setActiveStageTab("stage3")}
                  className="text-[10px] font-mono text-rosebery-primary underline underline-offset-2 hover:text-rosebery-charcoal transition-colors"
                >
                  View full detail →
                </button>
              </div>
              <div className="divide-y divide-rosebery-border">
                {report.recentAuctionSales.map((sale, sIdx) => (
                  <div key={sIdx} className="flex items-center justify-between py-2.5 gap-4">
                    <div className="min-w-0 flex-1">
                      <p className="text-sm font-serif font-semibold text-rosebery-charcoal truncate">{sale.artworkTitle}</p>
                      <p className="text-[11px] text-rosebery-muted">{sale.auctionHouse} · {sale.saleDate}</p>
                    </div>
                    <span className="text-sm font-mono font-bold text-rosebery-primary whitespace-nowrap">
                      {formatAndConvertPriceRealized(sale.priceRealized, currency) || (sale as any).hammerPrice || "—"}
                    </span>
                  </div>
                ))}
              </div>
            </div>
          )}
        </>
      )}

      {/* ----------------- TAB 2: STAGE 1 (VISUAL EXTRACTION) ----------------- */}
      {activeStageTab === "stage1" && (
        <>
          {report.stage1Result ? (
            <>
              {/* Stage 1 Raw Physical Observations Panel */}
              <div className="bg-white border border-rosebery-border rounded-xl p-6 md:p-8 shadow-gallery-soft space-y-6 animate-fadeIn">
                <div className="border-b border-rosebery-border pb-4 flex flex-col sm:flex-row sm:items-center justify-between gap-1">
                  <div>
                    <span className="text-[10px] font-mono uppercase tracking-[0.2em] text-rosebery-primary block mb-1 font-bold">
                      STAGE 1 — COMPUTER VISION PHYSICAL INSPECTION
                    </span>
                    <h3 className="text-xl md:text-2xl font-serif text-rosebery-charcoal font-semibold">
                      Raw Physical Observations
                    </h3>
                  </div>
                  <span className="text-[9px] font-mono text-rosebery-muted uppercase tracking-wider">
                    Visual Extraction Agent
                  </span>
                </div>

                <p className="text-xs text-rosebery-muted leading-relaxed">
                  The Visual Extraction Agent performs a pure physical inspection of the print layout without interpreting artist attribution or auction valuation. Below are the raw observations extracted from the high-resolution scan.
                </p>

                {/* Navigation Tabs */}
                <div className="flex flex-wrap border-b border-rosebery-border gap-2 text-xs font-mono">
                  {[
                    { id: "authenticity", label: "Authenticity & Scan" },
                    { id: "composition", label: "Subject & Style" },
                    { id: "paper", label: "Paper & Sheet" },
                    { id: "dimensions", label: "Dimensions & Margins" },
                    { id: "ink", label: "Ink & Printing" },
                    { id: "inscriptions", label: "Inscriptions & Stamps" },
                    { id: "defects", label: "Condition Defects" }
                  ].map((tab) => (
                    <button
                      key={tab.id}
                      type="button"
                      onClick={() => setActiveObsTab(tab.id as any)}
                      className={`pb-2.5 px-3 border-b-2 font-bold transition-all cursor-pointer ${
                        activeObsTab === tab.id
                          ? "border-rosebery-primary text-rosebery-primary"
                          : "border-transparent text-rosebery-muted hover:text-rosebery-primary"
                      }`}
                    >
                      {tab.label}
                    </button>
                  ))}
                </div>

                {/* Tab Content Panels */}
                <div className="pt-2 font-sans text-xs text-rosebery-text-normal">
                  
                  {/* Authenticity Tab */}
                  {activeObsTab === "authenticity" && (
                    <div className="space-y-4 animate-fadeIn">
                      <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-4">
                        <div className="bg-stone-50 border border-rosebery-border p-3.5 rounded">
                          <span className="text-[10px] font-mono text-rosebery-muted uppercase block mb-1">Image Classification</span>
                          <span className="font-bold text-rosebery-charcoal uppercase">{report.stage1Result.imageAuthenticity.classification.replace(/_/g, " ")}</span>
                        </div>
                        <div className="bg-stone-50 border border-rosebery-border p-3.5 rounded">
                          <span className="text-[10px] font-mono text-rosebery-muted uppercase block mb-1">Classification Confidence</span>
                          <span className="font-bold text-rosebery-primary">{(report.stage1Result.imageAuthenticity.classificationConfidence * 100).toFixed(0)}%</span>
                        </div>
                        <div className="bg-stone-50 border border-rosebery-border p-3.5 rounded col-span-1 sm:col-span-2">
                          <span className="text-[10px] font-mono text-rosebery-muted uppercase block mb-1">Authenticity Reliability Statement</span>
                          <span className="text-rosebery-muted italic leading-relaxed">"{report.stage1Result.imageAuthenticity.reliabilityStatement}"</span>
                        </div>
                      </div>

                      <div className="bg-stone-50 border border-rosebery-border p-4 rounded space-y-1.5">
                        <span className="text-[10px] font-mono text-rosebery-primary uppercase tracking-wider font-semibold block">Capture Methodology & Notes</span>
                        <p className="text-xs text-rosebery-muted leading-relaxed">{report.stage1Result.imageAuthenticity.captureMethodNotes}</p>
                      </div>

                      <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
                        {/* Physical Print Indicators */}
                        <div>
                          <span className="text-[10px] font-mono text-rosebery-primary uppercase tracking-wider font-bold block mb-2.5">PHYSICAL PRINT INDICATORS DETECTED</span>
                          {report.stage1Result.imageAuthenticity.physicalPrintIndicatorsFound && report.stage1Result.imageAuthenticity.physicalPrintIndicatorsFound.length > 0 ? (
                            <ul className="space-y-2">
                              {report.stage1Result.imageAuthenticity.physicalPrintIndicatorsFound.map((ind, idx) => (
                                <li key={idx} className="bg-emerald-50/50 border border-emerald-100 p-2.5 rounded text-emerald-950 flex flex-col space-y-1">
                                  <span className="font-bold font-mono text-[10px] text-emerald-800">✓ {ind.indicator}</span>
                                  <span className="text-[11px] text-emerald-900 leading-normal">{ind.description}</span>
                                </li>
                              ))}
                            </ul>
                          ) : (
                            <div className="text-rosebery-muted bg-stone-50 p-3.5 border border-rosebery-border rounded">No positive physical print evidence markers logged.</div>
                          )}
                        </div>

                        {/* Reproduction Indicators */}
                        <div>
                          <span className="text-[10px] font-mono text-rosebery-primary uppercase tracking-wider font-bold block mb-2.5">REPRODUCTION / POSTER INDICATORS DETECTED</span>
                          {report.stage1Result.imageAuthenticity.reproductionIndicatorsFound && report.stage1Result.imageAuthenticity.reproductionIndicatorsFound.length > 0 ? (
                            <ul className="space-y-2">
                              {report.stage1Result.imageAuthenticity.reproductionIndicatorsFound.map((ind, idx) => (
                                <li key={idx} className={`p-2.5 rounded flex flex-col space-y-1 border ${
                                  ind.conclusive 
                                    ? "bg-rose-50 border-rose-100 text-rose-950" 
                                    : "bg-amber-50/50 border-amber-100 text-amber-950"
                                }`}>
                                  <span className={`font-bold font-mono text-[10px] ${
                                    ind.conclusive ? "text-rose-800" : "text-amber-800"
                                  }`}>{ind.conclusive ? "⚠️ CRITICAL FLAG" : "✓ INDICATOR"} - {ind.indicator}</span>
                                  <span className="text-[11px] leading-normal">{ind.description}</span>
                                </li>
                              ))}
                            </ul>
                          ) : (
                            <div className="text-emerald-800 bg-emerald-50 border border-emerald-200 p-3.5 rounded flex items-center gap-1.5">
                              <CheckCircle2 className="w-4 h-4 text-emerald-600" />
                              No digital halftone dot structures or reproduction indicators logged.
                            </div>
                          )}
                        </div>
                      </div>
                    </div>
                  )}

                  {/* Composition Tab */}
                  {activeObsTab === "composition" && (
                    <div className="space-y-4 animate-fadeIn">
                      {report.stage1Result.composition ? (
                        <>
                          <div className="bg-stone-50 border border-rosebery-border p-4 rounded space-y-1.5">
                            <span className="text-[10px] font-mono text-rosebery-primary uppercase tracking-wider font-semibold block">Subject Matter</span>
                            <p className="text-sm text-rosebery-charcoal leading-relaxed">{report.stage1Result.composition.subjectMatter}</p>
                          </div>

                          <div className="bg-stone-50 border border-rosebery-border p-4 rounded space-y-1.5">
                            <span className="text-[10px] font-mono text-rosebery-primary uppercase tracking-wider font-semibold block">Visual Style</span>
                            <p className="text-sm text-rosebery-charcoal leading-relaxed">{report.stage1Result.composition.visualStyle}</p>
                          </div>

                          <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-4">
                            <div className="bg-stone-50 border border-rosebery-border p-3.5 rounded">
                              <span className="text-[10px] font-mono text-rosebery-muted uppercase block mb-1">Subject Category</span>
                              <span className="font-bold text-rosebery-charcoal uppercase">{report.stage1Result.composition.subjectCategory?.replace(/_/g, " ") || "Unknown"}</span>
                            </div>
                            <div className="bg-stone-50 border border-rosebery-border p-3.5 rounded">
                              <span className="text-[10px] font-mono text-rosebery-muted uppercase block mb-1">Image Boundary</span>
                              <span className="font-bold text-rosebery-charcoal uppercase">{report.stage1Result.composition.imageBoundary?.replace(/_/g, " ") || "Unknown"}</span>
                            </div>
                            <div className="bg-stone-50 border border-rosebery-border p-3.5 rounded">
                              <span className="text-[10px] font-mono text-rosebery-muted uppercase block mb-1">Image-to-Sheet Ratio</span>
                              <span className="font-bold text-rosebery-charcoal">{report.stage1Result.composition.imageToSheetRatio || "Not assessed"}</span>
                            </div>
                            <div className="bg-stone-50 border border-rosebery-border p-3.5 rounded">
                              <span className="text-[10px] font-mono text-rosebery-muted uppercase block mb-1">Composition Confidence</span>
                              <span className="font-bold text-rosebery-primary">
                                {typeof report.stage1Result.composition.compositionConfidence === "number"
                                  ? `${Math.round(report.stage1Result.composition.compositionConfidence * 100)}%`
                                  : "N/A"}
                              </span>
                            </div>
                          </div>

                          <div className="bg-stone-50 border border-rosebery-border p-4 rounded space-y-1.5">
                            <span className="text-[10px] font-mono text-rosebery-primary uppercase tracking-wider font-semibold block">Colour Palette</span>
                            <p className="text-xs text-rosebery-muted leading-relaxed">
                              {report.stage1Result.composition.colourPaletteSummary || "Not assessed"}
                              {typeof report.stage1Result.composition.numberOfColours === "number" && (
                                <span className="ml-2 font-mono text-rosebery-primary font-bold">({report.stage1Result.composition.numberOfColours} colours)</span>
                              )}
                            </p>
                          </div>

                          {(report.stage1Result.composition.textWithinImage || report.stage1Result.composition.dateWithinImage) && (
                            <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                              {report.stage1Result.composition.textWithinImage && (
                                <div className="bg-stone-50 border border-rosebery-border p-3.5 rounded">
                                  <span className="text-[10px] font-mono text-rosebery-muted uppercase block mb-1">Text Within Image</span>
                                  <span className="font-serif italic text-rosebery-primary">"{report.stage1Result.composition.textWithinImage}"</span>
                                </div>
                              )}
                              {report.stage1Result.composition.dateWithinImage && (
                                <div className="bg-stone-50 border border-rosebery-border p-3.5 rounded">
                                  <span className="text-[10px] font-mono text-rosebery-muted uppercase block mb-1">Date Within Image</span>
                                  <span className="font-bold text-rosebery-charcoal">{report.stage1Result.composition.dateWithinImage}</span>
                                </div>
                              )}
                            </div>
                          )}
                        </>
                      ) : (
                        <div className="text-rosebery-muted bg-stone-50 p-3.5 border border-rosebery-border rounded">No composition/style observations logged for this scan.</div>
                      )}
                    </div>
                  )}

                  {/* Paper Tab */}
                  {activeObsTab === "paper" && (
                    <div className="space-y-4 animate-fadeIn">
                      <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
                        <div className="bg-stone-50 border border-rosebery-border p-3.5 rounded">
                          <span className="text-[10px] font-mono text-rosebery-muted uppercase block mb-1">Paper Surface / Texture</span>
                          <span className="font-bold text-rosebery-charcoal uppercase">{report.stage1Result.paper.surfaceType || "Unknown"}</span>
                        </div>
                        <div className="bg-stone-50 border border-rosebery-border p-3.5 rounded">
                          <span className="text-[10px] font-mono text-rosebery-muted uppercase block mb-1">Paper Weight</span>
                          <span className="font-bold text-rosebery-charcoal uppercase">{report.stage1Result.paper.weight || "Unknown"}</span>
                        </div>
                        <div className="bg-stone-50 border border-rosebery-border p-3.5 rounded">
                          <span className="text-[10px] font-mono text-rosebery-muted uppercase block mb-1">Paper Tone</span>
                          <span className="font-bold text-rosebery-charcoal uppercase">{report.stage1Result.paper.tone.replace(/_/g, " ")}</span>
                        </div>
                        <div className="bg-stone-50 border border-rosebery-border p-3.5 rounded">
                          <span className="text-[10px] font-mono text-rosebery-muted uppercase block mb-1">Mounting Method</span>
                          <span className="font-bold text-rosebery-charcoal uppercase">{report.stage1Result.paper.mountingStatus.replace(/_/g, " ")}</span>
                        </div>
                      </div>

                      <div className="grid grid-cols-1 sm:grid-cols-3 gap-4">
                        <div className="bg-stone-50 border border-rosebery-border p-3.5 rounded">
                          <span className="text-[10px] font-mono text-rosebery-muted uppercase block mb-1">Laid Lines / Chain Lines</span>
                          <span className={`font-bold uppercase ${
                            report.stage1Result.paper.chainLinesVisible === true 
                              ? "text-emerald-800" 
                              : report.stage1Result.paper.chainLinesVisible === "uncertain"
                                ? "text-amber-800"
                                : "text-rosebery-muted"
                          }`}>
                            {String(report.stage1Result.paper.chainLinesVisible).toUpperCase()}
                          </span>
                        </div>
                        <div className="bg-stone-50 border border-rosebery-border p-3.5 rounded">
                          <span className="text-[10px] font-mono text-rosebery-muted uppercase block mb-1">Watermark Visible</span>
                          <span className={`font-bold uppercase ${
                            report.stage1Result.paper.watermarkVisible === true
                              ? "text-emerald-800" 
                              : report.stage1Result.paper.watermarkVisible === "uncertain"
                                ? "text-amber-800"
                                : "text-rosebery-muted"
                          }`}>
                            {String(report.stage1Result.paper.watermarkVisible).toUpperCase()}
                          </span>
                        </div>
                        {report.stage1Result.paper.watermarkDescription && (
                          <div className="bg-stone-50 border border-rosebery-border p-3.5 rounded col-span-1 sm:col-span-2">
                            <span className="text-[10px] font-mono text-rosebery-muted uppercase block mb-1">Watermark Motif Description</span>
                            <span className="font-serif italic text-rosebery-charcoal">"{report.stage1Result.paper.watermarkDescription}"</span>
                          </div>
                        )}
                      </div>
                    </div>
                  )}

                  {/* Dimensions & Margins Tab */}
                  {activeObsTab === "dimensions" && (
                    <div className="space-y-4 animate-fadeIn">
                      {(() => {
                        const dims = report.stage1Result.dimensions;
                        const hasPlate = dims.printedImageMM?.width && dims.printedImageMM?.height;
                        const hasSheet = dims.fullSheetMM?.width && dims.fullSheetMM?.height;
                        const hasScale = dims.sourceImage?.includes("supplementary_scale_photo");
                        const hasNotes = report.inferredDimensions && report.inferredDimensions.trim().length > 0;
                        if (!hasPlate && !hasSheet && !hasScale && !hasNotes) {
                          return (
                            <div className="bg-stone-50 border border-rosebery-border p-6 rounded text-center space-y-1.5">
                              <span className="text-[10px] font-mono text-rosebery-muted uppercase tracking-wider block">Dimensions Assessment</span>
                              <p className="text-sm font-serif italic text-rosebery-charcoal">No dimensions registered</p>
                              <p className="text-xs text-rosebery-muted">No scaled photograph or dimension notes were provided with this submission.</p>
                            </div>
                          );
                        }
                        return (
                          <>
                            <div className="grid grid-cols-1 sm:grid-cols-3 gap-4">
                              <div className="bg-stone-50 border border-rosebery-border p-3.5 rounded">
                                <span className="text-[10px] font-mono text-rosebery-muted uppercase block mb-1">Printed Area (Plate size)</span>
                                <span className="text-sm font-bold text-rosebery-charcoal font-mono">
                                  {hasPlate ? `${dims.printedImageMM.width} × ${dims.printedImageMM.height} mm` : "No dimensions registered"}
                                </span>
                              </div>
                              <div className="bg-stone-50 border border-rosebery-border p-3.5 rounded">
                                <span className="text-[10px] font-mono text-rosebery-muted uppercase block mb-1">Full Sheet Size</span>
                                <span className="text-sm font-bold text-rosebery-charcoal font-mono">
                                  {hasSheet ? `${dims.fullSheetMM.width} × ${dims.fullSheetMM.height} mm` : "No dimensions registered"}
                                </span>
                              </div>
                              <div className="bg-stone-50 border border-rosebery-border p-3.5 rounded">
                                <span className="text-[10px] font-mono text-rosebery-muted uppercase block mb-1">Sheet Margin Integrity</span>
                                <span className="font-bold text-rosebery-charcoal uppercase">{dims.marginCondition || "Unknown"}</span>
                              </div>
                            </div>
                            <div className="bg-stone-50 border border-rosebery-border p-4 rounded space-y-1.5">
                              <span className="text-[10px] font-mono text-rosebery-primary uppercase tracking-wider font-semibold block">Dimensions Source Specimen</span>
                              <p className="text-xs text-rosebery-muted leading-relaxed">
                                Visual extraction scale source: <span className="font-mono font-semibold text-rosebery-charcoal">{dims.sourceImage}</span>.
                                {hasScale
                                  ? " Estimated mathematically using the user-provided coin diameter next to the print boundary."
                                  : " Scaled programmatically based on standard catalogue ratios."}
                              </p>
                            </div>
                          </>
                        );
                      })()}
                    </div>
                  )}

                  {/* Ink & Printing Tab */}
                  {activeObsTab === "ink" && (
                    <div className="space-y-6 animate-fadeIn">
                      <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
                        <div className="bg-stone-50 border border-rosebery-border p-3.5 rounded">
                          <span className="text-[10px] font-mono text-rosebery-muted uppercase block mb-1">Color Mode</span>
                          <span className="font-bold text-rosebery-charcoal uppercase">{report.stage1Result.inkAndColour.colourMode || "Unknown"}</span>
                        </div>
                        <div className="bg-stone-50 border border-rosebery-border p-3.5 rounded">
                          <span className="text-[10px] font-mono text-rosebery-muted uppercase block mb-1">Ink Surface Sheen</span>
                          <span className="font-bold text-rosebery-charcoal uppercase">{report.stage1Result.inkAndColour.inkSurface || "Unknown"}</span>
                        </div>
                        <div className="bg-stone-50 border border-rosebery-border p-3.5 rounded">
                          <span className="text-[10px] font-mono text-rosebery-muted uppercase block mb-1">Ink Coverage Evenness</span>
                          <span className="font-bold text-rosebery-charcoal uppercase">{report.stage1Result.inkAndColour.inkCoverageEvenness || "Unknown"}</span>
                        </div>
                        <div className="bg-stone-50 border border-rosebery-border p-3.5 rounded">
                          <span className="text-[10px] font-mono text-rosebery-muted uppercase block mb-1">Selective Spot Varnishing</span>
                          <span className="font-bold text-rosebery-charcoal uppercase">{String(report.stage1Result.inkAndColour.selectiveVarnishing).toUpperCase()}</span>
                        </div>
                      </div>

                      <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
                        {/* Plate Mark details */}
                        <div className="bg-stone-50 border border-rosebery-border p-4 rounded space-y-3 shadow-xs">
                          <span className="text-[10px] font-mono text-rosebery-primary uppercase tracking-wider font-bold block border-b border-rosebery-border pb-1.5">PLATE LINE / MARK OBSERVATIONS</span>
                          <div className="grid grid-cols-2 gap-2 text-xs">
                            <div>
                              <span className="text-[9px] font-mono text-rosebery-muted block uppercase">Plate Mark Present</span>
                              <span className="font-semibold text-rosebery-charcoal uppercase">{String(report.stage1Result.plateMark.present).toUpperCase()}</span>
                            </div>
                            <div>
                              <span className="text-[9px] font-mono text-rosebery-muted block uppercase">Indent Clarity</span>
                              <span className="font-semibold text-rosebery-charcoal uppercase">{report.stage1Result.plateMark.clarity || "Unknown"}</span>
                            </div>
                            <div>
                              <span className="text-[9px] font-mono text-rosebery-muted block uppercase">Even margins</span>
                              <span className="font-semibold text-rosebery-charcoal uppercase">{String(report.stage1Result.plateMark.marginsEven).toUpperCase()}</span>
                            </div>
                          </div>
                          <div className="pt-2 border-t border-rosebery-border">
                            <span className="text-[9px] font-mono text-rosebery-muted block uppercase mb-0.5">Observation Notes</span>
                            <p className="text-xs text-rosebery-muted leading-relaxed">{report.stage1Result.plateMark.observationNotes}</p>
                          </div>
                        </div>

                        {/* Printing techniques identified */}
                        <div className="space-y-2">
                          <span className="text-[10px] font-mono text-rosebery-primary uppercase tracking-wider font-bold block mb-1">DETECTED PRODUCTION TECHNIQUES</span>
                          <ul className="space-y-2">
                            {report.stage1Result.printingTechniques && report.stage1Result.printingTechniques.length > 0 ? (
                              report.stage1Result.printingTechniques.map((tech, idx) => (
                                <li key={idx} className="bg-stone-50 border border-rosebery-border p-3 rounded space-y-1.5 shadow-xs">
                                  <div className="flex justify-between items-center">
                                    <span className="font-bold text-rosebery-charcoal">{tech.technique} ({tech.family})</span>
                                    <span className="bg-white border border-rosebery-border px-1.5 py-0.5 rounded font-mono font-bold text-rosebery-primary text-[9px]">
                                      {Math.round(tech.techniqueConfidence * 100)}% confidence
                                    </span>
                                  </div>
                                  {tech.visualEvidence && tech.visualEvidence.length > 0 && (
                                    <div className="flex flex-wrap gap-1 text-[9px]">
                                      {tech.visualEvidence.map((ev, i) => (
                                        <span key={i} className="bg-rosebery-cream-bg border border-rosebery-border px-1.5 py-0.5 rounded text-rosebery-muted">
                                          ✓ {ev}
                                        </span>
                                      ))}
                                    </div>
                                  )}
                                  {tech.conflictingEvidence && (
                                    <p className="text-[10px] text-amber-800 bg-amber-50 p-1.5 rounded-xs leading-relaxed">
                                      <strong>Conflicting:</strong> {tech.conflictingEvidence}
                                    </p>
                                  )}
                                </li>
                              ))
                            ) : (
                              <div className="text-rosebery-muted bg-stone-50 p-3.5 border border-rosebery-border rounded">No printmaking technique markers logged.</div>
                            )}
                          </ul>
                        </div>
                      </div>
                    </div>
                  )}

                  {/* Inscriptions & Stamps Tab */}
                  {activeObsTab === "inscriptions" && (
                    <div className="space-y-6 animate-fadeIn">
                      {/* Title Inscriptions */}
                      <div className="space-y-3">
                        <span className="text-[10px] font-mono text-rosebery-primary uppercase tracking-wider font-bold block border-b border-rosebery-border pb-1">TITLE INSCRIPTIONS & TEXT EVIDENCE</span>
                        {report.stage1Result.titleInscriptions && report.stage1Result.titleInscriptions.length > 0 ? (
                          <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                            {report.stage1Result.titleInscriptions.map((ti, idx) => (
                              <div key={idx} className="bg-stone-50 border border-rosebery-border p-3.5 rounded flex gap-4 shadow-xs">
                                {ti.box_2d && ti.box_2d.length === 4 && imageUrl && (
                                  <div className="w-32 h-32 shrink-0 rounded overflow-hidden border border-rosebery-border bg-white flex items-center justify-center">
                                    <EvidenceCrop imageUrl={imageUrl} box_2d={ti.box_2d} label="Title inscription" />
                                  </div>
                                )}
                                <div className="space-y-1 flex-1 text-xs">
                                  <div className="flex justify-between items-start gap-1">
                                    <span className="font-bold text-rosebery-charcoal uppercase text-[10px]">{ti.classification?.replace(/_/g, " ") || "Title Inscription"}</span>
                                    <span className="bg-white border border-rosebery-border px-1 py-0.5 rounded font-mono text-[9px] text-rosebery-primary font-bold">
                                      {typeof ti.titleConfidence === "number"
                                        ? `${(ti.titleConfidence <= 1 ? ti.titleConfidence * 100 : ti.titleConfidence).toFixed(0)}% confidence`
                                        : ti.titleConfidence}
                                    </span>
                                  </div>
                                  <p className="text-[11px] font-serif italic text-rosebery-primary">"{ti.transcription}"</p>
                                  <p className="text-[10px] text-rosebery-muted">Medium: <strong>{ti.medium}</strong> | Location: <strong>{ti.location}</strong></p>
                                </div>
                              </div>
                            ))}
                          </div>
                        ) : (
                          <div className="bg-stone-50 border border-rosebery-border p-4 rounded flex flex-col items-center justify-center space-y-1 text-center min-h-[72px]">
                            <span className="text-sm font-serif italic text-rosebery-charcoal">No title registered</span>
                            <span className="text-[10px] font-mono text-rosebery-muted">No title inscriptions, cartouches, or legible title text detected in the scan.</span>
                          </div>
                        )}
                      </div>

                      {/* Signatures */}
                      <div className="space-y-3">
                        <span className="text-[10px] font-mono text-rosebery-primary uppercase tracking-wider font-bold block border-b border-rosebery-border pb-1">SIGNATURE INSCRIBED SPECIMENS</span>
                        {report.stage1Result.signatures && report.stage1Result.signatures.length > 0 ? (
                          <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                            {report.stage1Result.signatures.map((sig, idx) => (
                              <div key={idx} className="bg-stone-50 border border-rosebery-border p-3.5 rounded flex gap-4 shadow-xs">
                                {sig.box_2d && sig.box_2d.length === 4 && imageUrl && (
                                  <div className="w-32 h-32 shrink-0 rounded overflow-hidden border border-rosebery-border bg-white flex items-center justify-center">
                                    <EvidenceCrop imageUrl={imageUrl} box_2d={sig.box_2d} label={sig.type} />
                                  </div>
                                )}
                                <div className="space-y-1 flex-1 text-xs">
                                  <div className="flex justify-between items-start gap-1">
                                    <span className="font-bold text-rosebery-charcoal uppercase text-[10px]">{sig.type.replace(/_/g, " ")}</span>
                                    <span className="bg-white border border-rosebery-border px-1 py-0.5 rounded font-mono text-[9px] text-rosebery-primary font-bold">{Math.round(sig.signatureConfidence * 100)}% confidence</span>
                                  </div>
                                  <p className="text-[11px] font-serif italic text-rosebery-primary">Transcription: "{sig.transcription}"</p>
                                  <p className="text-[10px] text-rosebery-muted">Medium: <strong>{sig.medium}</strong> | Location: <strong>{sig.location}</strong></p>
                                  <p className="text-[10px] text-rosebery-muted leading-relaxed italic mt-1 pt-1 border-t border-stone-200 font-sans">"{sig.authenticityNotes}"</p>
                                </div>
                              </div>
                            ))}
                          </div>
                        ) : (
                          <div className="text-rosebery-muted bg-stone-50 p-3.5 border border-rosebery-border rounded">No signature or hand inscriptions logged.</div>
                        )}
                      </div>

                      {/* Edition Info */}
                      <div className="space-y-3">
                        <span className="text-[10px] font-mono text-rosebery-primary uppercase tracking-wider font-bold block border-b border-rosebery-border pb-1">EDITION NUMBER INSCRIBED SPECIMENS</span>
                        {report.stage1Result.editionInfo && report.stage1Result.editionInfo.length > 0 ? (
                          <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                            {report.stage1Result.editionInfo.map((ed, idx) => (
                              <div key={idx} className="bg-stone-50 border border-rosebery-border p-3.5 rounded flex gap-4 shadow-xs">
                                {ed.box_2d && ed.box_2d.length === 4 && imageUrl && (
                                  <div className="w-32 h-32 shrink-0 rounded overflow-hidden border border-rosebery-border bg-white flex items-center justify-center">
                                    <EvidenceCrop imageUrl={imageUrl} box_2d={ed.box_2d} label={ed.type} />
                                  </div>
                                )}
                                <div className="space-y-1 flex-1 text-xs">
                                  <span className="font-bold text-rosebery-charcoal uppercase text-[10px]">{ed.type.replace(/_/g, " ")}</span>
                                  <p className="text-[11px] font-mono font-bold text-rosebery-primary">Transcription: {ed.transcription}</p>
                                  <p className="text-[10px] text-rosebery-muted">Method: <strong>{ed.inscriptionMethod}</strong> | Location: <strong>{ed.location}</strong></p>
                                </div>
                              </div>
                            ))}
                          </div>
                        ) : (
                          <div className="text-rosebery-muted bg-stone-50 p-3.5 border border-rosebery-border rounded">
                            {report.stage1Result.editionInfoAbsent ? "Edition markings confirmed absent from sheet." : "No edition markings registered."}
                          </div>
                        )}
                      </div>

                      {/* Stamps & Labels */}
                      <div className="space-y-3">
                        <span className="text-[10px] font-mono text-rosebery-primary uppercase tracking-wider font-bold block border-b border-rosebery-border pb-1">PRINTMAKER / COLLECTOR STAMPS & LABELS</span>
                        {report.stage1Result.stampsAndLabels && report.stage1Result.stampsAndLabels.length > 0 ? (
                          <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                            {report.stage1Result.stampsAndLabels.map((st, idx) => (
                              <div key={idx} className="bg-stone-50 border border-rosebery-border p-3.5 rounded flex gap-4 shadow-xs">
                                {st.box_2d && st.box_2d.length === 4 && imageUrl && (
                                  <div className="w-32 h-32 shrink-0 rounded overflow-hidden border border-rosebery-border bg-white flex items-center justify-center">
                                    <EvidenceCrop imageUrl={imageUrl} box_2d={st.box_2d} label={st.type} />
                                  </div>
                                )}
                                <div className="space-y-1 flex-1 text-xs">
                                  <span className="font-bold text-rosebery-charcoal uppercase text-[10px]">{st.type.replace(/_/g, " ")}</span>
                                  <p className="text-[11px] font-serif text-rosebery-charcoal">Transcription: "{st.transcription}"</p>
                                  <p className="text-[10px] text-rosebery-muted">Ink color: <strong>{st.inkColour}</strong> | Location: <strong>{st.location}</strong></p>
                                  {st.lugReference && (
                                    <p className="text-[9px] font-mono text-rosebery-primary bg-white border border-rosebery-border px-1.5 py-0.5 rounded-xs mt-1 w-max">Lugt: {st.lugReference}</p>
                                  )}
                                </div>
                              </div>
                            ))}
                          </div>
                        ) : (
                          <div className="text-rosebery-muted bg-stone-50 p-3.5 border border-rosebery-border rounded">No backplate stamps, framer stamps, or collector labels registered.</div>
                        )}
                      </div>
                    </div>
                  )}

                  {/* Condition Defects Tab */}
                  {activeObsTab === "defects" && (
                    <div className="space-y-4 animate-fadeIn">
                      <div className="flex flex-wrap gap-4 items-center justify-between border-b border-stone-200 pb-3">
                        <div>
                          <span className="text-xs text-rosebery-muted block mb-1">Visual Extraction Overall Grade</span>
                          <span className={`inline-flex items-center px-2.5 py-0.5 rounded border text-[10px] font-bold uppercase tracking-wider ${
                            report.stage1Result.condition.overallGrade.toLowerCase() === "mint"
                              ? "bg-teal-50 border-teal-200 text-teal-800"
                              : report.stage1Result.condition.overallGrade.toLowerCase().includes("good")
                                ? "bg-emerald-50 border-emerald-200 text-emerald-800"
                                : "bg-amber-50 border-amber-200 text-amber-800"
                          }`}>
                            ★ {report.stage1Result.condition.overallGrade}
                          </span>
                        </div>
                        {report.stage1Result.condition.restorationEvidence && (
                          <div className="bg-amber-50 border border-amber-100 px-3 py-1.5 rounded-sm text-[11px] text-amber-900">
                            <strong>Restoration Evidence Detected:</strong> {report.stage1Result.condition.restorationNotes || "Manual touchups or patching visible."}
                          </div>
                        )}
                      </div>

                      <span className="text-[10px] font-mono text-rosebery-primary uppercase tracking-wider font-bold block mb-1">DETECTED ENVIRONMENTAL & PHYSICAL DEFECTS</span>
                      {report.stage1Result.condition.defects && report.stage1Result.condition.defects.length > 0 ? (
                        <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
                          {report.stage1Result.condition.defects.map((def, idx) => (
                            <div key={idx} className="bg-stone-50 border border-rosebery-border p-3.5 rounded flex gap-4 shadow-xs">
                              {def.box_2d && def.box_2d.length === 4 && imageUrl && (
                                <div className="w-32 h-32 shrink-0 rounded overflow-hidden border border-rosebery-border bg-white flex items-center justify-center">
                                  <EvidenceCrop imageUrl={imageUrl} box_2d={def.box_2d} label={def.type} />
                                </div>
                              )}
                              <div className="space-y-1 flex-1 text-xs">
                                <div className="flex justify-between items-start gap-1">
                                  <span className="font-bold text-rosebery-charcoal uppercase text-[10px]">{def.type.replace(/_/g, " ")}</span>
                                  <span className={`px-1.5 py-0.5 rounded font-mono text-[9px] font-bold ${
                                    def.severity === "SIGNIFICANT" 
                                      ? "bg-rose-100 text-rose-800" 
                                      : def.severity === "MODERATE"
                                        ? "bg-amber-100 text-amber-800"
                                        : "bg-stone-200 text-rosebery-charcoal"
                                  }`}>{def.severity}</span>
                                </div>
                                <p className="text-[10px] text-rosebery-muted">Category: <strong>{def.category.replace(/_/g, " ")}</strong> | Location: <strong>{def.location}</strong></p>
                                <p className="text-[10px] text-rosebery-muted">Affects Image Area: <strong>{def.affectsImageArea ? "Yes (High Penalty)" : "No (Margin Only)"}</strong></p>
                              </div>
                            </div>
                          ))}
                        </div>
                      ) : (
                        <div className="text-emerald-800 bg-emerald-50 border border-emerald-200 p-3.5 rounded flex items-center gap-1.5">
                          <CheckCircle2 className="w-4 h-4 text-emerald-600" />
                          No mechanical tears, creases, or tonal stain points extracted by image analysis.
                        </div>
                      )}
                    </div>
                  )}

                </div>
              </div>

            </>
          ) : (
            <div className="bg-stone-50 border border-rosebery-border p-8 rounded-xl text-center space-y-2 animate-fadeIn">
              <Layers className="w-8 h-8 text-rosebery-primary mx-auto opacity-65" />
              <h4 className="text-sm font-semibold font-mono text-rosebery-charcoal uppercase">Detail not captured in legacy report</h4>
              <p className="text-xs text-rosebery-muted max-w-md mx-auto">
                This appraisal was processed prior to the integration of the 3-Stage Pipeline. Raw Stage 1 physical observations (paper weight, plate marks, stamps) are not available.
              </p>
            </div>
          )}


        </>
      )}

      {/* ----------------- TAB 3: STAGE 2 (ATTRIBUTION & COMPS) ----------------- */}
      {activeStageTab === "stage2" && (
        <>
          {/* Detailed Attribution & Catalog Register Match Card */}
          <div className="bg-white border border-rosebery-border rounded-xl p-6 md:p-8 shadow-gallery-soft space-y-6 animate-fadeIn">
            <div className="border-b border-rosebery-border pb-4 flex flex-col sm:flex-row sm:items-center justify-between gap-1">
              <div>
                <span className="text-[10px] font-mono uppercase tracking-[0.2em] text-rosebery-primary block mb-1 font-bold">
                  STAGE 2 — ATTRIBUTION & CATALOG REGISTER MATCH
                </span>
                <h3 className="text-xl md:text-2xl font-serif text-rosebery-charcoal font-semibold">
                  Attribution & Scholarly Research
                </h3>
              </div>
              <span className="text-[9px] font-mono text-rosebery-muted uppercase tracking-wider">
                Attribution & Market Research Agent
              </span>
            </div>

            <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
              {/* Left Column: Dial confidence */}
              <div className="space-y-4">
                <span className="text-[10px] font-mono text-rosebery-primary uppercase tracking-wider font-bold block mb-1">PROBABILITY DIALS</span>
                <div className="grid grid-cols-2 gap-4">
                  <div className="bg-stone-50 border border-rosebery-border p-4 rounded shadow-xs text-center">
                    <span className="text-[10px] font-mono text-rosebery-muted uppercase block mb-1">Artist Attribution</span>
                    <span className="text-2xl font-bold text-rosebery-charcoal font-serif">{report.artistConfidence}%</span>
                    <div className="w-full bg-[#E8E2D7] h-1.5 rounded-full mt-2 overflow-hidden">
                      <div className="bg-rosebery-primary h-full" style={{ width: `${report.artistConfidence}%` }} />
                    </div>
                  </div>
                  <div className="bg-stone-50 border border-rosebery-border p-4 rounded shadow-xs text-center">
                    <span className="text-[10px] font-mono text-rosebery-muted uppercase block mb-1">Title Identification</span>
                    <span className="text-2xl font-bold text-rosebery-charcoal font-serif">{report.titleConfidence}%</span>
                    <div className="w-full bg-[#E8E2D7] h-1.5 rounded-full mt-2 overflow-hidden">
                      <div className="bg-rosebery-primary h-full" style={{ width: `${report.titleConfidence}%` }} />
                    </div>
                  </div>
                </div>

                <div className="bg-stone-50 border border-rosebery-border p-4 rounded text-xs space-y-1">
                  <span className="font-bold text-rosebery-charcoal block">Attributed Work:</span>
                  <p className="font-serif italic text-rosebery-muted">"{report.artworkTitle}" by {report.likelyArtist}</p>
                  <p className="text-[11px] text-rosebery-muted mt-1">Creation Period: <strong>{report.creationPeriod}</strong></p>
                </div>

                {/* Top 3 Artist Candidates Table */}
                {report.stage2aResult?.candidateArtists && report.stage2aResult.candidateArtists.length > 0 && (
                  <div className="space-y-2">
                    <span className="text-[10px] font-mono text-rosebery-primary uppercase tracking-wider font-bold block">TOP ARTIST CANDIDATES</span>
                    <table className="w-full text-xs border border-rosebery-border rounded overflow-hidden">
                      <thead>
                        <tr className="bg-rosebery-primary text-white">
                          <th className="text-left px-3 py-2 font-mono text-[10px] uppercase tracking-wider">Rank</th>
                          <th className="text-left px-3 py-2 font-mono text-[10px] uppercase tracking-wider">Artist</th>
                          <th className="text-right px-3 py-2 font-mono text-[10px] uppercase tracking-wider">Probability</th>
                        </tr>
                      </thead>
                      <tbody>
                        {report.stage2aResult.candidateArtists.slice(0, 3).map((c, i) => (
                          <tr key={i} className={i % 2 === 0 ? "bg-white" : "bg-stone-50"}>
                            <td className="px-3 py-2 font-mono font-bold text-rosebery-primary">#{c.rank}</td>
                            <td className="px-3 py-2 font-serif text-rosebery-charcoal">{c.artistName}</td>
                            <td className="px-3 py-2 text-right font-bold font-mono text-rosebery-primary">
                              {(c.candidateProbability * 100).toFixed(0)}%
                              <div className="w-full bg-[#E8E2D7] h-1 rounded-full mt-1 overflow-hidden">
                                <div className="bg-rosebery-primary h-full" style={{ width: `${c.candidateProbability * 100}%` }} />
                              </div>
                            </td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                )}

                {/* Top 3 Title Candidates from titleInscriptions */}
                {report.stage1Result?.titleInscriptions && (report.stage1Result.titleInscriptions as any[]).length > 0 && (
                  <div className="space-y-2">
                    <span className="text-[10px] font-mono text-rosebery-primary uppercase tracking-wider font-bold block">TOP TITLE CANDIDATES (FROM INSCRIPTIONS)</span>
                    <table className="w-full text-xs border border-rosebery-border rounded overflow-hidden">
                      <thead>
                        <tr className="bg-rosebery-primary text-white">
                          <th className="text-left px-3 py-2 font-mono text-[10px] uppercase tracking-wider">#</th>
                          <th className="text-left px-3 py-2 font-mono text-[10px] uppercase tracking-wider">Title Transcription</th>
                          <th className="text-left px-3 py-2 font-mono text-[10px] uppercase tracking-wider">Location</th>
                          <th className="text-right px-3 py-2 font-mono text-[10px] uppercase tracking-wider">Confidence</th>
                        </tr>
                      </thead>
                      <tbody>
                        {(report.stage1Result.titleInscriptions as any[]).slice(0, 3).map((t: any, i: number) => (
                          <tr key={i} className={i % 2 === 0 ? "bg-white" : "bg-stone-50"}>
                            <td className="px-3 py-2 font-mono font-bold text-rosebery-primary">#{i + 1}</td>
                            <td className="px-3 py-2 font-serif italic text-rosebery-charcoal">"{t.transcription}"</td>
                            <td className="px-3 py-2 text-rosebery-muted text-[10px]">{t.location}</td>
                            <td className="px-3 py-2 text-right font-bold font-mono text-rosebery-primary">
                              {typeof t.titleConfidence === "number" ? `${(t.titleConfidence * 100).toFixed(0)}%` : t.titleConfidence}
                            </td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                )}
              </div>

              {/* Right Column: Catalogue Raisonné & References */}
              <div className="bg-stone-50 border border-rosebery-border p-5 rounded space-y-4 shadow-xs">
                <span className="text-[10px] font-mono text-rosebery-primary uppercase tracking-wider font-bold block border-b border-rosebery-border pb-1.5">CATALOGUE RAISONNÉ REFERENCES</span>
                {(() => {
                  const s2 = report.stage2Result;
                  if (!s2) return null;
                  if (s2.schemaVersion === "ASA-1.0") {
                    const asaS2 = s2 as ASAAttributionResult;
                    const cr = asaS2.catalogueRaisonne;
                    const ac = asaS2.attributionConclusion;
                    return (
                      <div className="space-y-3">
                        {cr.referenceFound ? (
                          <div className="space-y-2">
                            <div className="bg-emerald-50 border border-emerald-100 p-2.5 rounded text-emerald-950 flex items-start gap-2 text-xs">
                              <CheckCircle2 className="w-4 h-4 text-emerald-600 shrink-0 mt-0.5" />
                              <div>
                                <strong>Verified Match Found:</strong>
                                <p className="font-serif italic text-emerald-900 mt-0.5">{cr.catalogueName} {cr.plateOrCatalogueNumber}</p>
                              </div>
                            </div>
                            <p className="text-xs text-rosebery-muted leading-relaxed">{cr.catalogueEditionInfo}</p>
                          </div>
                        ) : (
                          <div className="bg-amber-50 border border-amber-100 p-2.5 rounded text-amber-950 flex items-start gap-2 text-xs">
                            <Info className="w-4 h-4 text-amber-600 shrink-0 mt-0.5" />
                            <div>
                              <strong>Catalogue Reference Scan:</strong>
                              <p className="mt-0.5">No direct catalogue raisonné reference resolved from specialist research.</p>
                            </div>
                          </div>
                        )}
                        {/* Artist period/style context */}
                        <div className="border-t border-rosebery-border pt-3 space-y-2">
                          <span className="text-[10px] font-mono text-rosebery-primary uppercase tracking-wider font-bold block">ARTIST PERIOD & STYLISTIC CONTEXT</span>
                          {ac.dateOrPeriod && (
                            <p className="text-xs text-rosebery-muted leading-relaxed">
                              <strong className="text-rosebery-charcoal">Working Period:</strong> {ac.dateOrPeriod}
                            </p>
                          )}
                          {ac.technique && (
                            <p className="text-xs text-rosebery-muted leading-relaxed">
                              <strong className="text-rosebery-charcoal">Identified Technique:</strong> {ac.technique}
                            </p>
                          )}
                          {ac.confirmedSeriesName && (
                            <p className="text-xs text-rosebery-muted leading-relaxed">
                              <strong className="text-rosebery-charcoal">Series:</strong> {ac.confirmedSeriesName}
                            </p>
                          )}
                          {asaS2.valuationRelevantFindings?.rarityFactors?.length > 0 && (
                            <div>
                              <span className="text-[10px] font-mono text-rosebery-primary uppercase tracking-wider block mb-1">Rarity Factors:</span>
                              <ul className="space-y-0.5">
                                {asaS2.valuationRelevantFindings.rarityFactors.map((f, i) => (
                                  <li key={i} className="text-xs text-rosebery-muted flex items-start gap-1.5">
                                    <span className="text-rosebery-primary shrink-0">•</span>{f}
                                  </li>
                                ))}
                              </ul>
                            </div>
                          )}
                          {ac.attributionEvidenceChain?.length > 0 && (
                            <div>
                              <span className="text-[10px] font-mono text-rosebery-primary uppercase tracking-wider block mb-1">Attribution Evidence:</span>
                              <ul className="space-y-0.5">
                                {ac.attributionEvidenceChain.slice(0, 4).map((e, i) => (
                                  <li key={i} className="text-xs text-rosebery-muted flex items-start gap-1.5">
                                    <span className="text-emerald-600 shrink-0">✓</span>{e}
                                  </li>
                                ))}
                              </ul>
                            </div>
                          )}
                        </div>
                      </div>
                    );
                  }
                  // Legacy 3-stage result
                  const legacyS2 = s2 as LegacyAttributionResult;
                  return legacyS2.catalogueRaisonneMatch?.matched ? (
                    <div className="space-y-2">
                      <div className="bg-emerald-50 border border-emerald-100 p-2.5 rounded text-emerald-950 flex items-start gap-2 text-xs">
                        <CheckCircle2 className="w-4 h-4 text-emerald-600 shrink-0 mt-0.5" />
                        <div>
                          <strong>Verified Match Found:</strong>
                          <p className="font-serif italic text-emerald-900 mt-0.5">{legacyS2.catalogueRaisonneMatch!.referenceName}</p>
                        </div>
                      </div>
                      <p className="text-xs text-rosebery-muted leading-relaxed">{legacyS2.catalogueRaisonneMatch!.notes}</p>
                    </div>
                  ) : (
                    <div className="space-y-2">
                      <div className="bg-amber-50 border border-amber-100 p-2.5 rounded text-amber-950 flex items-start gap-2 text-xs">
                        <Info className="w-4 h-4 text-amber-600 shrink-0 mt-0.5" />
                        <div>
                          <strong>Catalogue Reference Scan:</strong>
                          <p className="mt-0.5">No direct matching index number resolved from the standard catalogue raisonné.</p>
                        </div>
                      </div>
                      <p className="text-xs text-rosebery-muted leading-relaxed">
                        {legacyS2.catalogueRaisonneMatch?.notes || "Cross-referenced artist print bibliographies for style patterns, edition layout, and margins."}
                      </p>
                    </div>
                  );
                })()}
              </div>
            </div>
          </div>

          {/* Composition & Historical Context — moved from Valuation tab */}
          <div className="grid grid-cols-1 md:grid-cols-2 gap-8 animate-fadeIn">
            <div className="bg-white border border-rosebery-border rounded-xl p-6 shadow-gallery-soft">
              <span className="text-xs font-mono tracking-[0.2em] text-rosebery-primary uppercase flex items-center gap-2 mb-3.5 font-bold">
                <Info className="w-4 h-4" />
                COMPOSITION & ICONOGRAPHY NOTES
              </span>
              {isEditing ? (
                <textarea
                  value={editVisualDescription}
                  onChange={(e) => setEditVisualDescription(e.target.value)}
                  rows={6}
                  className="w-full bg-rosebery-sage border border-rosebery-sage-border focus:border-rosebery-primary focus:ring-1 focus:ring-rosebery-primary/20 rounded-sm p-3 text-xs text-rosebery-text-normal focus:outline-none leading-relaxed"
                  placeholder="Visual composition notes..."
                />
              ) : (
                <p className="text-xs text-rosebery-muted leading-relaxed">{report.visualDescription}</p>
              )}
            </div>
            <div className="bg-white border border-rosebery-border rounded-xl p-6 shadow-gallery-soft">
              <span className="text-xs font-mono tracking-[0.2em] text-rosebery-primary uppercase flex items-center gap-2 mb-3.5 font-bold">
                <Compass className="w-4 h-4" />
                HISTORICAL SIGNIFICANCE & BACKGROUND
              </span>
              {isEditing ? (
                <textarea
                  value={editHistoricalContext}
                  onChange={(e) => setEditHistoricalContext(e.target.value)}
                  rows={6}
                  className="w-full bg-rosebery-sage border border-rosebery-sage-border focus:border-rosebery-primary focus:ring-1 focus:ring-rosebery-primary/20 rounded-sm p-3 text-xs text-rosebery-text-normal focus:outline-none leading-relaxed"
                  placeholder="Historical context notes..."
                />
              ) : (
                <p className="text-xs text-rosebery-muted leading-relaxed">{report.historicalContext}</p>
              )}
            </div>
          </div>

          {/* Editions & Reprint Verification Card — only shown for legacy 3-stage results */}
          {(() => {
            const s2raw = report.stage2Result;
            if (!s2raw || s2raw.schemaVersion === "ASA-1.0") return null;
            const s2 = s2raw as LegacyAttributionResult;
            return (
              <div className="bg-white border border-rosebery-border rounded-xl p-6 shadow-gallery-soft space-y-6 animate-fadeIn">
                <div className="border-b border-rosebery-border pb-3.5">
                  <span className="text-xs font-mono tracking-[0.2em] text-rosebery-primary uppercase block mb-1 font-bold">
                    STAGE 2 — EDITIONS & REPRINT VERIFICATION
                  </span>
                  <h3 className="text-xl md:text-2xl font-serif text-rosebery-charcoal font-semibold">
                    Known Editions & Reprint Analysis
                  </h3>
                </div>

                <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
                  {/* Editions Information */}
                  <div className="bg-stone-50 border border-rosebery-border p-5 rounded space-y-2 shadow-xs">
                    <span className="text-[10px] font-mono text-rosebery-primary uppercase tracking-wider font-bold block border-b border-rosebery-border pb-1.5">
                      KNOWN EDITIONS & PRINT RUNS
                    </span>
                    <p className="text-xs text-rosebery-muted leading-relaxed whitespace-pre-line font-sans">
                      {s2.editionsInformation}
                    </p>
                  </div>

                  {/* Reprint Safety & Posthumous Check */}
                  <div className="space-y-4">
                    <div className={`p-4 rounded border text-xs space-y-1.5 ${
                      s2.isPosthumousReprint
                        ? "bg-rose-50 border-rose-100 text-rose-950"
                        : "bg-emerald-50 border-emerald-100 text-emerald-950"
                    }`}>
                      <span className="font-bold font-mono text-[10px] uppercase block tracking-wider">
                        {s2.isPosthumousReprint ? "⚠️ Posthumous Reprint Flagged" : "✓ Lifetime Printing Assessed"}
                      </span>
                      <p className="leading-relaxed">
                        {s2.isPosthumousReprint
                          ? "Later restrikes or posthumous reprints of this print design are documented. Additional verification of paper watermarks and ink quality is recommended."
                          : "There are no major posthumous edition restrikes documented for this print design that conflict with lifetime impressions."}
                      </p>
                      {s2.posthumousReprintDetails && (
                        <p className="text-[11px] font-semibold mt-1">
                          Details: {s2.posthumousReprintDetails}
                        </p>
                      )}
                    </div>

                    {/* Edition Synthesis Evidence */}
                    <div className="bg-stone-50 border border-rosebery-border p-5 rounded space-y-2 shadow-xs">
                      <span className="text-[10px] font-mono text-rosebery-primary uppercase tracking-wider font-bold block border-b border-rosebery-border pb-1.5">
                        EDITION EVIDENCE SYNTHESIS
                      </span>
                      <p className="text-xs text-rosebery-muted leading-relaxed font-sans">
                        {s2.editionSynthesisEvidence}
                      </p>
                    </div>
                  </div>
                </div>
              </div>
            );
          })()}
        </>
      )}

      {/* ----------------- TAB 4: STAGE 3 (VALUATION & CONTEXT) ----------------- */}
      {activeStageTab === "stage3" && (
        <>
          {/* Valuation Panel */}
          {renderValuationPanel()}

          {/* Recent Auction Sales block */}
          {report.recentAuctionSales && report.recentAuctionSales.length > 0 ? (
            <div className="bg-white border border-rosebery-border rounded-xl p-6 shadow-gallery-soft space-y-4 animate-fadeIn">
              <div className="flex flex-col md:flex-row md:items-center justify-between gap-2 border-b border-rosebery-border pb-3">
                <span className="text-xs font-mono tracking-[0.2em] text-rosebery-primary uppercase flex items-center gap-2 font-bold">
                  <Coins className="w-4 h-4 text-rosebery-primary" />
                  RECENT BENCHMARK SALES (SAME OR SIMILAR PRINTS)
                </span>
                <span className="text-[10px] font-mono text-rosebery-muted uppercase tracking-wider">
                  Market Pricing Indexes
                </span>
              </div>
              <div className="text-xs text-rosebery-muted bg-stone-50 p-3 rounded border border-rosebery-border leading-relaxed font-sans">
                These are public record benchmarks for corresponding print states, catalog editions, and impressions by this printmaker or similar contemporary runs of this medium/period.
              </div>
              <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4 pt-1">
                {report.recentAuctionSales.map((sale, sIdx) => (
                  <div key={sIdx} className="bg-stone-50 border border-rosebery-border p-4 rounded-lg flex flex-col justify-between space-y-3 shadow-xs">
                    <div className="space-y-1.5">
                      <div className="flex justify-between items-start gap-2">
                        <h5 className="font-serif font-semibold text-rosebery-charcoal text-sm line-clamp-1">{sale.artworkTitle}</h5>
                        <span className="text-xs font-mono font-bold text-rosebery-primary bg-white px-2 py-0.5 rounded border border-rosebery-border shrink-0">
                          {formatAndConvertPriceRealized(sale.priceRealized, currency) || "—"}
                        </span>
                      </div>
                      <p className="text-[11px] text-rosebery-muted">{sale.artist} • <span className="italic font-serif">{sale.technique}</span></p>
                    </div>
                    
                    <div className="border-t border-rosebery-border pt-2.5 space-y-1 text-xs">
                      <div className="flex justify-between text-[11px]">
                        <span className="text-rosebery-muted font-mono">PRICE REALIZED</span>
                        <span className="text-rosebery-charcoal font-bold">{formatAndConvertPriceRealized(sale.priceRealized, currency) || "—"}</span>
                      </div>
                      <div className="flex justify-between text-[11px]">
                        <span className="text-rosebery-muted font-mono">AUCTION HOUSE</span>
                        <span className="text-rosebery-charcoal font-semibold">{sale.auctionHouse}</span>
                      </div>
                      <div className="flex justify-between text-[11px]">
                        <span className="text-rosebery-muted font-mono">SALE DATE</span>
                        <span className="text-rosebery-muted">{sale.saleDate}</span>
                      </div>
                      <div className="text-[11px] text-rosebery-muted mt-1.5 pt-1.5 border-t border-rosebery-border italic leading-relaxed">
                        <span className="text-rosebery-muted font-mono not-italic block text-[9px] uppercase tracking-wider mb-0.5 font-bold">STATE RECORD NOTE</span>
                        "{sale.conditionState}"
                      </div>
                      {sale.wasSoldInBroaderLot !== undefined && (
                        <div className="text-[11px] mt-2.5 pt-2 border-t border-rosebery-border leading-relaxed">
                          <div className="flex items-center gap-1 mb-1">
                            <span className="text-rosebery-muted font-mono text-[9px] uppercase tracking-wider font-bold">GROUP LOT ALLOCATION</span>
                          </div>
                          {sale.wasSoldInBroaderLot ? (
                            <div className="bg-[#FFF9F2] border border-[#F0DDC5] p-2 rounded-xs">
                              <p className="text-rosebery-primary text-[10px] font-sans font-semibold leading-tight">
                                Sold inside broader lot (Fractional value applied)
                              </p>
                              {sale.broaderLotPriceAdjustment && (
                                <p className="text-[10px] font-mono text-rosebery-muted mt-1">
                                  Value Allocation: <span className="text-emerald-700 font-bold">{formatAndConvertPriceRealized(sale.broaderLotPriceAdjustment, currency)}</span>
                                </p>
                              )}
                            </div>
                          ) : (
                            <div className="bg-emerald-50 border border-emerald-100 p-2 rounded-xs text-emerald-800 font-sans text-[10px] leading-tight flex items-center gap-1">
                              <span>Standalone Transaction</span>
                              <span className="text-[9px] text-emerald-700 font-mono">• No Allocation Needed</span>
                            </div>
                          )}
                        </div>
                      )}
                    </div>
                  </div>
                ))}
              </div>
            </div>
          ) : (
            <div className="bg-stone-50 border border-rosebery-border p-8 rounded-xl text-center space-y-2 animate-fadeIn">
              <Coins className="w-8 h-8 text-rosebery-primary mx-auto opacity-65" />
              <h4 className="text-sm font-semibold font-mono text-rosebery-charcoal uppercase">No benchmark comps logged</h4>
              <p className="text-xs text-rosebery-muted max-w-md mx-auto">
                No recent transactions or auction records were extracted for comparison with this print style.
              </p>
            </div>
          )}

        </>
      )}

    </div>{/* end #art-report-view */}

      {/* ── Print Report — outside screen div, shown only in @media print ── */}
      <div className="hidden print:block certificate-print-container" style={{
        fontFamily: "'Inter', 'Helvetica Neue', Helvetica, Arial, sans-serif",
        color: "#1C1115",
        background: "#FDFBF8",
        boxSizing: "border-box",
        width: "100%",
      }}>

        {/* ── Two-column: image + physical record ── */}
        <div className="print-no-break" style={{ display: "grid", gridTemplateColumns: "36% 1fr", gap: "18px", marginBottom: "14px", borderTop: "3px solid #C0AA84", paddingTop: "12px" }}>
          {/* Image */}
          <div>
            {imageUrl ? (
              <img
                src={imageUrl}
                alt={report.artworkTitle}
                style={{ width: "100%", height: "auto", maxHeight: "240px", objectFit: "contain", display: "block", border: "1px solid #E8E2D7", background: "#FAF8F5" }}
              />
            ) : (
              <div style={{ border: "1px solid #E8E2D7", background: "#FAF8F5", height: "160px", display: "flex", alignItems: "center", justifyContent: "center" }}>
                <span style={{ fontFamily: "'JetBrains Mono', monospace", fontSize: "9px", color: "#7A6C71" }}>No image provided</span>
              </div>
            )}
          </div>

          {/* Physical record */}
          <div style={{ display: "flex", flexDirection: "column", gap: "0" }}>
            {/* Title + artist as compact header row */}
            <div style={{ marginBottom: "8px" }}>
              <h1 style={{
                fontFamily: "'Cormorant Garamond', 'Palatino Linotype', Palatino, Georgia, serif",
                fontSize: "22px", fontWeight: 500, lineHeight: 1.15,
                color: "#1C1115", letterSpacing: "0.01em", margin: "0 0 3px",
              }}>
                {report.artworkTitle}
              </h1>
              <div style={{ display: "flex", alignItems: "baseline", gap: "8px" }}>
                <span style={{ fontFamily: "'Cormorant Garamond', Georgia, serif", fontSize: "13px", fontStyle: "italic", color: "#4C0B2A", fontWeight: 500 }}>
                  {report.likelyArtist}
                </span>
                <span style={{ fontFamily: "'JetBrains Mono', monospace", fontSize: "8px", color: "#7A6C71" }}>
                  {report.artistConfidence}% confidence
                </span>
              </div>
            </div>
            {/* Record table */}
            {([
              ["Period", report.creationPeriod],
              ["Technique", (report.techniques || [])[0]?.technique || "—"],
              ["Paper", report.stage1Result?.paper?.surfaceType?.replace(/_/g, " ") || "—"],
              ["Mounting", report.stage1Result?.paper?.mountingStatus?.replace(/_/g, " ") || "—"],
              ["Edition", typeof report.editionSizeAndPrintNumber === "object"
                ? Object.values(report.editionSizeAndPrintNumber as any).filter(Boolean).join(", ")
                : (report.editionSizeAndPrintNumber || "—")],
              ["Condition", safeCond(report).overallGrade || "—"],
            ] as [string, string][]).map(([label, value]) => (
              <div key={label} style={{ display: "flex", borderBottom: "1px solid #E8E2D7", padding: "4px 0", gap: "12px", alignItems: "baseline" }}>
                <span style={{ fontFamily: "'JetBrains Mono', monospace", fontSize: "8px", textTransform: "uppercase", letterSpacing: "0.13em", color: "#7A6C71", minWidth: "90px", flexShrink: 0 }}>
                  {label}
                </span>
                <span style={{ fontSize: "10px", color: "#1C1115", fontWeight: 500, lineHeight: 1.4 }}>
                  {value}
                </span>
              </div>
            ))}
          </div>
        </div>

        {/* ── Direct Observations ── */}
        {(() => {
          const sigs   = (report.stage1Result?.signatures   || []).filter((s: any) => s.box_2d?.length === 4);
          const titles = (report.stage1Result?.titleInscriptions || []).filter((t: any) => t.box_2d?.length === 4);
          const eds    = (report.stage1Result?.editionInfo   || []).filter((e: any) => e.box_2d?.length === 4);
          const defects= (report.stage1Result?.condition?.defects || []).filter((d: any) => d.box_2d?.length === 4);
          const hasSupp = (supplementaryImages || []).length > 0;
          const hasCrops = sigs.length || titles.length || eds.length || defects.length;
          if (!hasSupp && !hasCrops) return null;

          const labelStyle: React.CSSProperties = {
            fontFamily: "'JetBrains Mono', monospace", fontSize: "7.5px",
            textTransform: "uppercase", letterSpacing: "0.14em", color: "#7A6C71",
            display: "block", marginTop: "4px", textAlign: "center",
          };
          const cropCardStyle: React.CSSProperties = {
            display: "flex", flexDirection: "column", alignItems: "center",
            background: "#FAF8F5", border: "1px solid #E8E2D7", padding: "6px",
            breakInside: "avoid",
          };

          return (
            <div className="print-no-break" style={{ marginBottom: "12px" }}>
              <span style={{ fontFamily: "'JetBrains Mono', monospace", fontSize: "8px", textTransform: "uppercase", letterSpacing: "0.18em", color: "#7A6C71", display: "block", marginBottom: "8px", borderBottom: "1px solid #E8E2D7", paddingBottom: "3px" }}>
                Direct Observations
              </span>
              <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fill, minmax(90px, 1fr))", gap: "8px" }}>

                {/* Supplementary upload photos */}
                {(supplementaryImages || []).map((supp, i) => (
                  <div key={`supp-${i}`} style={cropCardStyle}>
                    <img src={supp.imageUrl} alt={supp.caption || `Supplementary photo ${i + 1}`} style={{ width: "100%", height: "80px", objectFit: "contain", background: "#fff" }} />
                    <span style={labelStyle}>{supp.caption || `Supplementary photo ${i + 1}`}</span>
                  </div>
                ))}

                {/* Box-crop evidence from stage1 */}
                {imageUrl && sigs.map((sig: any, i: number) => (
                  <div key={`sig-${i}`} style={cropCardStyle}>
                    <div style={{ width: "100%", height: "80px", overflow: "hidden", background: "#fff", display: "flex", alignItems: "center", justifyContent: "center" }}>
                      <EvidenceCrop imageUrl={imageUrl} box_2d={sig.box_2d} label={sig.type} />
                    </div>
                    <span style={labelStyle}>{sig.type?.replace(/_/g, " ") || "Signature"}</span>
                    {sig.transcription && <span style={{ ...labelStyle, fontStyle: "italic", color: "#4C0B2A" }}>"{sig.transcription}"</span>}
                  </div>
                ))}
                {imageUrl && titles.map((ti: any, i: number) => (
                  <div key={`ti-${i}`} style={cropCardStyle}>
                    <div style={{ width: "100%", height: "80px", overflow: "hidden", background: "#fff", display: "flex", alignItems: "center", justifyContent: "center" }}>
                      <EvidenceCrop imageUrl={imageUrl} box_2d={ti.box_2d} label="Title inscription" />
                    </div>
                    <span style={labelStyle}>Title inscription</span>
                    {ti.transcription && <span style={{ ...labelStyle, fontStyle: "italic", color: "#4C0B2A" }}>"{ti.transcription}"</span>}
                  </div>
                ))}
                {imageUrl && eds.map((ed: any, i: number) => (
                  <div key={`ed-${i}`} style={cropCardStyle}>
                    <div style={{ width: "100%", height: "80px", overflow: "hidden", background: "#fff", display: "flex", alignItems: "center", justifyContent: "center" }}>
                      <EvidenceCrop imageUrl={imageUrl} box_2d={ed.box_2d} label={ed.type} />
                    </div>
                    <span style={labelStyle}>{ed.type?.replace(/_/g, " ") || "Edition"}</span>
                    {ed.transcription && <span style={{ ...labelStyle, fontStyle: "italic", color: "#4C0B2A" }}>"{ed.transcription}"</span>}
                  </div>
                ))}
                {imageUrl && defects.map((def: any, i: number) => (
                  <div key={`def-${i}`} style={cropCardStyle}>
                    <div style={{ width: "100%", height: "80px", overflow: "hidden", background: "#fff", display: "flex", alignItems: "center", justifyContent: "center" }}>
                      <EvidenceCrop imageUrl={imageUrl} box_2d={def.box_2d} label={def.type} />
                    </div>
                    <span style={labelStyle}>{def.type?.replace(/_/g, " ") || "Defect"}</span>
                  </div>
                ))}

              </div>
            </div>
          );
        })()}

        {/* ── Valuation ── */}
        {(safeEst(report).lowEstimate || 0) > 0 && (
          <div className="print-no-break" style={{
            background: "#FAF8F5", border: "1px solid #E8E2D7",
            borderLeft: "3px solid #4C0B2A",
            padding: "10px 14px", marginBottom: "12px",
          }}>
            <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: "8px" }}>
              <span style={{ fontFamily: "'JetBrains Mono', monospace", fontSize: "8px", textTransform: "uppercase", letterSpacing: "0.2em", color: "#7A6C71" }}>
                Auction Estimate
              </span>
              <span style={{
                fontFamily: "'Cormorant Garamond', Georgia, serif",
                fontSize: "20px", fontWeight: 600, color: "#4C0B2A",
                letterSpacing: "0.02em",
              }}>
                {getCurrencySymbol(safeEst(report).currency)}{safeEst(report).lowEstimate?.toLocaleString()}
                <span style={{ color: "#C0AA84", margin: "0 6px" }}>–</span>
                {getCurrencySymbol(safeEst(report).currency)}{safeEst(report).highEstimate?.toLocaleString()}
                {" "}
                <span style={{ fontSize: "13px", fontWeight: 400, color: "#7A6C71" }}>{safeEst(report).currency}</span>
              </span>
            </div>
            {safeEst(report).valuationContext && (
              <p style={{ fontSize: "9.5px", color: "#3E3238", lineHeight: 1.55, margin: 0 }}>
                {safeEst(report).valuationContext}
              </p>
            )}
            {(safeEst(report).basisNarrative || safeEst(report).estimateBasis || safeEst(report).basisSummary) && (
              <p style={{ fontSize: "8.5px", color: "#3E3238", lineHeight: 1.55, marginTop: "6px", borderTop: "1px solid #E8E2D7", paddingTop: "6px", margin: "6px 0 0" }}>
                {safeEst(report).basisNarrative || safeEst(report).estimateBasis || safeEst(report).basisSummary}
              </p>
            )}
          </div>
        )}

        {/* ── Condition notes ── */}
        {safeCond(report).analysisDetails && (
          <div className="print-no-break" style={{ marginBottom: "12px" }}>
            <span style={{ fontFamily: "'JetBrains Mono', monospace", fontSize: "8px", textTransform: "uppercase", letterSpacing: "0.18em", color: "#7A6C71", display: "block", marginBottom: "5px", borderBottom: "1px solid #E8E2D7", paddingBottom: "3px" }}>
              Condition &amp; Conservation
            </span>
            <p style={{ fontSize: "9.5px", color: "#3E3238", lineHeight: 1.6, margin: 0 }}>
              {safeCond(report).analysisDetails}
            </p>
          </div>
        )}

        {/* ── Comparable auction sales ── */}
        {report.recentAuctionSales && report.recentAuctionSales.length > 0 && (
          <div className="print-no-break" style={{ marginBottom: "12px" }}>
            <span style={{ fontFamily: "'JetBrains Mono', monospace", fontSize: "8px", textTransform: "uppercase", letterSpacing: "0.18em", color: "#7A6C71", display: "block", marginBottom: "6px", borderBottom: "1px solid #E8E2D7", paddingBottom: "3px" }}>
              Comparable Sales
            </span>
            <table style={{ width: "100%", borderCollapse: "collapse", fontSize: "9.5px" }}>
              <thead>
                <tr style={{ borderBottom: "1px solid #E8E2D7" }}>
                  {["Work", "Artist", "Technique", "House", "Date", "Price"].map(h => (
                    <th key={h} style={{ fontFamily: "'JetBrains Mono', monospace", fontSize: "7.5px", textTransform: "uppercase", letterSpacing: "0.12em", color: "#7A6C71", fontWeight: 500, textAlign: "left", padding: "3px 6px 3px 0" }}>
                      {h}
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {report.recentAuctionSales.map((sale, idx) => (
                  <tr key={idx} style={{ borderBottom: "1px solid #E8E2D7" }}>
                    <td style={{ padding: "5px 6px 5px 0", color: "#1C1115", fontStyle: "italic", fontFamily: "'Cormorant Garamond', Georgia, serif", fontSize: "10px", maxWidth: "160px" }}>
                      {sale.artworkTitle}
                      {sale.wasSoldInBroaderLot && <span style={{ fontFamily: "'JetBrains Mono', monospace", fontSize: "7px", color: "#C0AA84", marginLeft: "4px", fontStyle: "normal" }}>lot</span>}
                    </td>
                    <td style={{ padding: "5px 6px 5px 0", color: "#3E3238" }}>{sale.artist}</td>
                    <td style={{ padding: "5px 6px 5px 0", color: "#7A6C71" }}>{sale.technique}</td>
                    <td style={{ padding: "5px 6px 5px 0", color: "#3E3238", whiteSpace: "nowrap" }}>{sale.auctionHouse}</td>
                    <td style={{ padding: "5px 6px 5px 0", color: "#7A6C71", whiteSpace: "nowrap", fontFamily: "'JetBrains Mono', monospace", fontSize: "8.5px" }}>{sale.saleDate}</td>
                    <td style={{ padding: "5px 0", color: "#4C0B2A", fontWeight: 600, whiteSpace: "nowrap", fontVariantNumeric: "tabular-nums" }}>
                      {formatAndConvertPriceRealized(sale.priceRealized, currency) || (sale as any).hammerPrice || "—"}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}

        {/* ── Historical context (if present) ── */}
        {report.historicalContext && (
          <div className="print-no-break" style={{ marginBottom: "12px" }}>
            <span style={{ fontFamily: "'JetBrains Mono', monospace", fontSize: "8px", textTransform: "uppercase", letterSpacing: "0.18em", color: "#7A6C71", display: "block", marginBottom: "5px", borderBottom: "1px solid #E8E2D7", paddingBottom: "3px" }}>
              Historical Context
            </span>
            <p style={{ fontSize: "9.5px", color: "#3E3238", lineHeight: 1.6, margin: 0 }}>
              {report.historicalContext}
            </p>
          </div>
        )}

        {/* ── AI disclaimer ── */}
        <div className="print-no-break" style={{
          borderTop: "1px solid #E8E2D7", marginTop: "16px", paddingTop: "10px",
          display: "flex", gap: "10px", alignItems: "flex-start",
        }}>
          <span style={{ fontSize: "11px", color: "#C0AA84", flexShrink: 0, lineHeight: 1 }}>⚠</span>
          <p style={{ fontSize: "8.5px", color: "#7A6C71", lineHeight: 1.55, margin: 0 }}>
            <strong style={{ color: "#3E3238", fontWeight: 600 }}>AI-generated content — treat with caution.</strong>{" "}
            This report was produced by artificial intelligence. Attribution, condition assessment, and valuation outputs are probabilistic estimates and may contain errors. This document does not constitute a professional appraisal, guarantee of authenticity, or investment advice. All findings must be independently verified by a qualified fine art specialist before any commercial or legal reliance is placed upon them.
          </p>
        </div>

        {/* ── Footer ── */}
        <div className="print-no-break" style={{
          borderTop: "1px solid #C0AA84", marginTop: "14px", paddingTop: "8px",
          display: "flex", justifyContent: "space-between", alignItems: "flex-end",
        }}>
          <div>
            <span style={{ fontFamily: "'JetBrains Mono', monospace", fontSize: "7.5px", textTransform: "uppercase", letterSpacing: "0.15em", color: "#7A6C71", display: "block" }}>
              Reference
            </span>
            <span style={{ fontFamily: "'JetBrains Mono', monospace", fontSize: "8.5px", color: "#1C1115", letterSpacing: "0.08em" }}>
              PM-{report.artworkTitle.substring(0, 4).replace(/[^a-zA-Z]/g, "").toUpperCase()}-{new Date().getFullYear()}
            </span>
            {report.modelUsed && (
              <span style={{ fontFamily: "'JetBrains Mono', monospace", fontSize: "7.5px", color: "#7A6C71", display: "block", marginTop: "2px" }}>
                {resolveMethodLabel(report.promptVersion || "standard", report.modelUsed)}
              </span>
            )}
          </div>
          <div style={{ textAlign: "right" }}>
            <span style={{ fontFamily: "'JetBrains Mono', monospace", fontSize: "7.5px", textTransform: "uppercase", letterSpacing: "0.15em", color: "#7A6C71", display: "block" }}>
              Curator signature
            </span>
            <div style={{ width: "120px", borderTop: "1px dashed #C0AA84", marginTop: "18px", marginLeft: "auto" }} />
          </div>
        </div>

      </div>
    </>
  );
}
