import React from "react";
import { FileText, ShieldAlert, Sparkles } from "lucide-react";

interface AppraiserNotesInputProps {
  userNotes: string;
  setUserNotes: (val: string) => void;
  provenanceNotes: string;
  setProvenanceNotes: (val: string) => void;
  conditionNotes: string;
  setConditionNotes: (val: string) => void;
  literatureNotes: string;
  setLiteratureNotes: (val: string) => void;
  selectedFile: File | null;
  error: string | null;
  onSubmit: () => void;
  appraisalMethod: string;
  setAppraisalMethod: (val: string) => void;
  appraisalMethods: any[];
}

export default function AppraiserNotesInput({
  userNotes,
  setUserNotes,
  provenanceNotes,
  setProvenanceNotes,
  conditionNotes,
  setConditionNotes,
  literatureNotes,
  setLiteratureNotes,
  selectedFile,
  error,
  onSubmit,
  appraisalMethod,
  setAppraisalMethod,
  appraisalMethods,
}: AppraiserNotesInputProps) {
  const selectedMethod = appraisalMethods.find(m => m.id === appraisalMethod);

  return (
    <div className="lg:col-span-5 bg-stone-50 border border-rosebery-border p-5 md:p-6 rounded-sm space-y-5 shadow-gallery-soft transition-all duration-200">
      <div className="border-b border-rosebery-border pb-3 flex items-center gap-2 text-rosebery-primary">
        <FileText className="w-4 h-4" />
        <span className="text-[16.5px] font-mono uppercase tracking-[0.2em] font-bold">Other Observations & Notes</span>
      </div>

      <p className="text-[10.5px] text-rosebery-muted leading-relaxed -mt-2">
        Submit precise, multi-tiered provenance, inscribed plate notes, and framing observations. Gemini integrates these values directly to cross-reference historical guide records and maximize estimation accuracy.
      </p>

      {/* Appraisal Method / Pipeline Selection */}
      <div className="space-y-1.5 bg-rosebery-cream-bg/30 border border-rosebery-border/80 rounded-sm p-3">
        <label className="text-[10px] font-mono uppercase tracking-wider text-rosebery-primary font-bold block flex items-center justify-between">
          <span>Appraisal Method / LLM Model</span>
          <span className="text-[9px] text-rosebery-gold font-mono font-semibold tracking-wider uppercase">Config</span>
        </label>
        <select
          value={appraisalMethod}
          onChange={(e) => setAppraisalMethod(e.target.value)}
          className="w-full bg-rosebery-card border border-rosebery-border focus:border-rosebery-primary focus:ring-1 focus:ring-rosebery-primary/20 rounded-sm p-2 text-xs text-rosebery-charcoal outline-hidden font-mono transition-all duration-200 cursor-pointer"
        >
          {appraisalMethods.map((method) => {
            return (
              <option key={method.id} value={method.id}>
                {method.name}
              </option>
            );
          })}
        </select>
        {selectedMethod && (
          <div className="mt-2 space-y-1 text-[10px] font-mono text-rosebery-muted leading-relaxed border-t border-rosebery-border/40 pt-1.5">
            <p className="text-rosebery-charcoal font-semibold">{selectedMethod.description}</p>
            <p className="text-[9px] flex gap-2.5 mt-1">
              <span>Image Quality: <strong className="text-rosebery-primary uppercase">{selectedMethod.imageQuality}</strong></span>
              <span>Aux Scans: <strong className="text-rosebery-primary uppercase">{selectedMethod.includeAuxiliaryScans ? "Yes" : "No"}</strong></span>
            </p>
          </div>
        )}
      </div>

      {/* Input A: Inscribed Text */}
      <div className="space-y-1.5">
        <label className="text-[10px] font-mono uppercase tracking-wider text-rosebery-primary font-semibold block flex items-center justify-between">
          <span>1. Inscription Marks & Text</span>
          <span className="text-[9px] text-rosebery-gold lowercase italic font-mono font-normal">Optional</span>
        </label>
        <textarea
          value={userNotes}
          onChange={(e) => setUserNotes(e.target.value)}
          placeholder="E.g., Pencil numbers bottom-left border reading 'Ed. 45 / 75', artist signature monogram, monotype plate marks..."
          rows={2}
          className="w-full bg-rosebery-card border border-rosebery-border focus:border-rosebery-primary focus:ring-1 focus:ring-rosebery-primary/20 rounded-sm p-3 text-xs text-rosebery-charcoal outline-hidden placeholder:text-stone-400 font-mono transition-all duration-200"
        />
      </div>

      {/* Input B: Provenance Details */}
      <div className="space-y-1.5">
        <label className="text-[10px] font-mono uppercase tracking-wider text-rosebery-primary font-semibold block flex items-center justify-between">
          <span>2. Art Provenance & Ownership Chain</span>
          <span className="text-[9px] text-rosebery-gold lowercase italic font-mono font-normal">Optional</span>
        </label>
        <textarea
          value={provenanceNotes}
          onChange={(e) => setProvenanceNotes(e.target.value)}
          placeholder="E.g., Acquired from Sotheby's multiple sale in 1994, originally from the collection of Dr. Julian Smith, London..."
          rows={2}
          className="w-full bg-rosebery-card border border-rosebery-border focus:border-rosebery-primary focus:ring-1 focus:ring-rosebery-primary/20 rounded-sm p-3 text-xs text-rosebery-charcoal outline-hidden placeholder:text-stone-400 font-mono transition-all duration-200"
        />
      </div>

      {/* Input C: Condition & Sheet quality */}
      <div className="space-y-1.5">
        <label className="text-[10px] font-mono uppercase tracking-wider text-rosebery-primary font-semibold block flex items-center justify-between">
          <span>3. Surface Physical Condition Notes</span>
          <span className="text-[9px] text-rosebery-gold lowercase italic font-mono font-normal">Optional</span>
        </label>
        <textarea
          value={conditionNotes}
          onChange={(e) => setConditionNotes(e.target.value)}
          placeholder="E.g., Slight cockling on bottom-right margin, minor acid framing lines, linen-backed on acid-free boards..."
          rows={2}
          className="w-full bg-rosebery-card border border-rosebery-border focus:border-rosebery-primary focus:ring-1 focus:ring-rosebery-primary/20 rounded-sm p-3 text-xs text-rosebery-charcoal outline-hidden placeholder:text-stone-400 font-mono transition-all duration-200"
        />
      </div>

      {/* Input D: Literature references */}
      <div className="space-y-1.5">
        <label className="text-[10px] font-mono uppercase tracking-wider text-rosebery-primary font-semibold block flex items-center justify-between">
          <span>4. Catalogues & Lit References</span>
          <span className="text-[9px] text-rosebery-gold lowercase italic font-mono font-normal">Optional</span>
        </label>
        <textarea
          value={literatureNotes}
          onChange={(e) => setLiteratureNotes(e.target.value)}
          placeholder="E.g., Conforms to Bartsch Bart-105-D catalogue reference on 17th Century etching reproductions..."
          rows={2}
          className="w-full bg-rosebery-card border border-rosebery-border focus:border-rosebery-primary focus:ring-1 focus:ring-rosebery-primary/20 rounded-sm p-3 text-xs text-rosebery-charcoal outline-hidden placeholder:text-stone-400 font-mono transition-all duration-200"
        />
      </div>

      {/* Submission and error controls */}
      <div className="space-y-3 pt-3.5 border-t border-rosebery-border">
        {error && (
          <div className="bg-rose-50 border border-rose-200 text-rose-800 p-3.5 rounded-sm text-xs leading-relaxed flex items-start gap-2.5 animate-fadeIn">
            <ShieldAlert className="w-3.5 h-3.5 mt-0.5 shrink-0 text-rose-600" />
            <span>{error}</span>
          </div>
        )}

        <button
          onClick={onSubmit}
          disabled={!selectedFile}
          className={`w-full py-3.5 rounded-sm text-xs md:text-sm font-bold tracking-[0.25em] uppercase transition-all duration-200 flex items-center justify-center gap-2 ${
            selectedFile
              ? "bg-rosebery-primary text-white hover:bg-rosebery-primary-hover cursor-pointer shadow-gallery-soft hover:scale-[1.01]"
              : "bg-rosebery-border border border-[#DCD6CA] text-stone-400 cursor-not-allowed"
          }`}
        >
          <Sparkles className="w-4 h-4" />
          Begin Archival Analysis Scan
        </button>
      </div>
    </div>
  );
}
