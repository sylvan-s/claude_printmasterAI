import React from "react";
import { Upload, X } from "lucide-react";

export interface SupplementaryPhotoDraft {
  id: string;
  // null when loaded from a previously-saved item (no re-uploadable File
  // available) — such photos display but are skipped on re-analysis.
  file: File | null;
  preview: string;
  caption: string;
}

interface UploadPanelProps {
  selectedFile: File | null;
  previewUrl: string | null;
  dragActive: boolean;
  onDrag: (e: React.DragEvent) => void;
  onDrop: (e: React.DragEvent) => void;
  onFileSelect: (file: File) => void;
  onClear: () => void;
  fileInputRef: React.RefObject<HTMLInputElement | null>;

  supplementaryPhotos: SupplementaryPhotoDraft[];
  onAddSupplementaryPhoto: (file: File) => void;
  onRemoveSupplementaryPhoto: (id: string) => void;
  onSupplementaryCaptionChange: (id: string, caption: string) => void;
  supplementaryInputRef: React.RefObject<HTMLInputElement | null>;
}

const formatBytes = (bytes: number) => {
  if (bytes === 0) return "0 Bytes";
  const k = 1024;
  const sizes = ["Bytes", "KB", "MB"];
  const i = Math.floor(Math.log(bytes) / Math.log(k));
  return parseFloat((bytes / Math.pow(k, i)).toFixed(1)) + " " + sizes[i];
};

export default function UploadPanel({
  selectedFile,
  previewUrl,
  dragActive,
  onDrag,
  onDrop,
  onFileSelect,
  onClear,
  fileInputRef,
  supplementaryPhotos,
  onAddSupplementaryPhoto,
  onRemoveSupplementaryPhoto,
  onSupplementaryCaptionChange,
  supplementaryInputRef,
}: UploadPanelProps) {
  const triggerFileInput = () => {
    fileInputRef.current?.click();
  };

  return (
    <div className="lg:col-span-7 space-y-6">
      {/* Explanatory introduction */}
      <div className="text-center space-y-2.5">
        <span className="inline-flex bg-rosebery-cream-bg border border-rosebery-border px-3.5 py-1.5 rounded-sm text-xs font-serif text-rosebery-primary font-medium tracking-wide italic">
          Identify lithographs, copper engravings, serigraphs, and limited runs.
        </span>
        <h2 className="text-2xl md:text-3xl font-serif font-semibold text-rosebery-charcoal tracking-wide">
          Photographic Evidence
        </h2>
        <p className="text-xs md:text-sm text-rosebery-muted leading-relaxed">
          Upload a high-fidelity photograph of the print sheet. Our AI engine scans line engraving depth, plate marks, registration boundaries, and paper aging traits to instantly detail matching printmakers, catalogue references, and physical conditions.
        </p>
      </div>

      {/* Dropzone container */}
      <div
        onDragEnter={onDrag}
        onDragOver={onDrag}
        onDragLeave={onDrag}
        onDrop={onDrop}
        onClick={triggerFileInput}
        className={`border-2 border-dashed rounded-sm p-8 md:p-12 text-center cursor-pointer transition-all duration-200 ease-out relative ${
          dragActive
            ? "border-rosebery-primary bg-rosebery-cream-bg shadow-gallery-soft"
            : "border-rosebery-border hover:border-rosebery-primary bg-stone-50 hover:bg-rosebery-cream-bg"
        }`}
      >
        <input
          ref={fileInputRef}
          type="file"
          accept="image/*"
          onChange={(e) => e.target.files?.[0] && onFileSelect(e.target.files[0])}
          className="hidden"
        />

        {previewUrl ? (
          <div className="space-y-4" onClick={(e) => e.stopPropagation()}>
            <div className="relative mx-auto max-w-[280px] rounded-sm overflow-hidden border border-rosebery-border shadow-gallery-deep bg-rosebery-card">
              <img
                src={previewUrl}
                alt="Uploaded Print Preview"
                className="max-h-56 mx-auto object-contain p-2"
              />
              <button
                onClick={onClear}
                className="absolute top-2.5 right-2.5 bg-rosebery-primary text-white hover:bg-rosebery-primary-hover rounded-full p-2 hover:scale-105 cursor-pointer transition-all duration-200"
                title="Remove Photo"
              >
                <X className="w-3.5 h-3.5 stroke-[3]" />
              </button>
            </div>
            <div className="text-xs text-rosebery-muted bg-rosebery-cream-bg p-3 rounded border border-rosebery-border inline-block font-mono">
              <p className="font-semibold text-rosebery-charcoal">{selectedFile?.name}</p>
              <p className="text-rosebery-gold mt-0.5">
                {selectedFile?.size ? formatBytes(selectedFile.size) : ""}
              </p>
            </div>
          </div>
        ) : (
          <div className="space-y-4 py-4">
            <div className="mx-auto w-12 h-12 rounded-full bg-rosebery-primary text-white flex items-center justify-center shadow-gallery-soft">
              <Upload className="w-5 h-5 stroke-[2]" />
            </div>
            <div>
              <p className="text-sm font-semibold text-rosebery-charcoal font-serif tracking-wide">
                Drag and drop high-resolution print photograph here, or browse
              </p>
              <p className="text-[11px] text-rosebery-muted mt-1 font-mono">
                Supports PNG, JPEG, WEBP files (Max size 15 MB)
              </p>
            </div>
          </div>
        )}
      </div>

      {/* Supplementary Photos Section */}
      <div className="bg-stone-50 border border-rosebery-border p-4 md:p-5 rounded-sm space-y-4">
        <div className="border-b border-rosebery-border pb-2 flex flex-col sm:flex-row sm:items-center justify-between gap-1">
          <span className="text-[10px] font-mono uppercase tracking-[0.2em] text-rosebery-primary block font-bold">
            SUPPLEMENTARY PHOTOS (OPTIONAL)
          </span>
          <span className="text-[9px] font-mono text-rosebery-gold uppercase tracking-wider font-semibold">
            Enhance Appraisal Accuracy
          </span>
        </div>

        <p className="text-[10.5px] text-rosebery-muted leading-relaxed">
          Add any extra photos that support the appraisal — a signature close-up, a
          damage detail, the reverse of the sheet, a ruler or coin for scale, or
          anything else worth a closer look. After each upload, describe in your own
          words what the photo shows; that description is passed directly to the
          inspection agent.
        </p>

        <input
          ref={supplementaryInputRef}
          type="file"
          accept="image/*"
          onChange={(e) => {
            const file = e.target.files?.[0];
            if (file) onAddSupplementaryPhoto(file);
            e.target.value = ""; // allow re-selecting the same file again
          }}
          className="hidden"
        />

        <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
          {supplementaryPhotos.map((photo, index) => (
            <div
              key={photo.id}
              className="bg-rosebery-card border border-rosebery-border rounded-sm p-3 flex flex-col gap-2.5 relative"
            >
              <div className="flex items-start gap-2.5">
                <div className="relative w-20 h-20 flex-shrink-0 rounded-sm overflow-hidden bg-rosebery-cream-bg border border-rosebery-border">
                  <img src={photo.preview} alt={`Supplementary photo ${index + 1}`} className="w-full h-full object-cover" />
                </div>
                <div className="flex-1 min-w-0 space-y-1">
                  <label className="text-[10px] font-mono text-rosebery-charcoal font-bold block uppercase tracking-wider">
                    Photo {index + 1} — what does this show?
                  </label>
                  <textarea
                    value={photo.caption}
                    onChange={(e) => onSupplementaryCaptionChange(photo.id, e.target.value)}
                    placeholder="e.g. Close-up of the pencil signature, lower right margin"
                    rows={3}
                    className="w-full text-[11px] font-mono text-rosebery-charcoal bg-white border border-rosebery-border rounded-xs px-2 py-1.5 resize-none focus:outline-none focus:border-rosebery-primary"
                  />
                </div>
                <button
                  type="button"
                  onClick={() => onRemoveSupplementaryPhoto(photo.id)}
                  className="absolute top-1.5 right-1.5 bg-red-600 hover:bg-red-700 text-white rounded p-1 shadow transition-all cursor-pointer"
                  title="Remove photo"
                >
                  <X className="w-3 h-3 stroke-[2.5]" />
                </button>
              </div>
            </div>
          ))}

          <button
            type="button"
            onClick={() => supplementaryInputRef.current?.click()}
            className="py-4 px-3 border border-dashed border-rosebery-border hover:border-rosebery-primary bg-stone-50 text-[11px] font-mono text-rosebery-muted hover:text-rosebery-primary rounded-xs transition-colors flex items-center justify-center gap-1.5 cursor-pointer duration-200 min-h-[104px]"
          >
            <Upload className="w-3.5 h-3.5 text-rosebery-primary" />
            Add Supplementary Photo
          </button>
        </div>
      </div>
    </div>
  );
}
