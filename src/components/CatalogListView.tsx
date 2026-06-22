import React from "react";
import { Download, Mail, Trash2, Folder, Hash, FileText, Check, Loader2, GripVertical, FileSpreadsheet, Sparkles, Layers, History } from "lucide-react";
import { AnalysisHistoryItem, PrintAnalysisReport, CatalogMetadata } from "../types";
import HistorySidebar from "./HistorySidebar";
import LotCreatorModal from "./LotCreatorModal";
import { resolveMethodLabel } from "../utils/resolveMethodLabel";

interface CatalogListViewProps {
  isHistoryLoading: boolean;
  catalogHistory: AnalysisHistoryItem[];
  selectedHistoryId: string | null;
  setSelectedHistoryId: (id: string | null) => void;
  selectedItemIds: string[];
  setSelectedItemIds: (ids: string[]) => void;
  toggleItemSelection: (id: string) => void;
  updateItemLot: (id: string, lotNumber: string, lotTitle: string) => void;
  updateItemCatalogue: (id: string, catalogueId: string | null) => void;
  deleteHistoryItem: (id: string, e: React.MouseEvent) => void;
  catalogViewMode: "inspector" | "tabular";
  setCatalogViewMode: (mode: "inspector" | "tabular") => void;
  currency: "USD" | "GBP" | "EUR";
  setCurrency: (val: "USD" | "GBP" | "EUR") => void;
  columnWidths: { [key: string]: number };
  setColumnWidths: React.Dispatch<React.SetStateAction<{ [key: string]: number }>>;

  handleResizeStart: (colKey: string, startX: number, startWidth: number) => void;
  lotNumberInput: string;
  lotTitleInput: string;
  aiProposingLot: boolean;
  handleLotNumberInputChange: (val: string) => void;
  handleLotTitleInputChange: (val: string) => void;
  updateHistory: (newHistory: AnalysisHistoryItem[]) => void;
  draggedIndex: number | null;
  dragOverIndex: number | null;
  handleHistoryDragStart: (e: React.DragEvent, index: number) => void;
  handleHistoryDragOver: (e: React.DragEvent, index: number) => void;
  handleHistoryDragEnd: () => void;
  handleHistoryDrop: (e: React.DragEvent, targetIndex: number) => void;
  isGroupedByLot: boolean;
  onLoadHistoryItem: (item: AnalysisHistoryItem) => void;
  catalogs: CatalogMetadata[];
  activeCatalogId: string;
  onSwitchCatalog: (id: string) => Promise<void>;
  onRenameCatalog: (oldId: string, newId: string, name: string) => Promise<void>;
  onDeleteCatalog: (id: string) => Promise<void>;
  createNewCatalog: (name: string) => Promise<string>;
  updateMultipleItemsCatalogue: (ids: string[], catalogueId: string | null) => void;
  onNavigate: (tab: "sandbox" | "batch" | "history" | "settings") => void;
}

const getCurrencySymbol = (code: string) => {
  if (code === "USD") return "$";
  if (code === "GBP") return "£";
  if (code === "EUR") return "€";
  return "";
};

const convertValue = (val: number, from: string, to: string): number => {
  if (!from || !to || from.toUpperCase() === to.toUpperCase()) return val;

  let valInUSD = val;
  const origin = from.toUpperCase();
  const target = to.toUpperCase();

  if (origin === "GBP") valInUSD = val * 1.25;
  else if (origin === "EUR") valInUSD = val * 1.09;

  if (target === "USD") return Math.round(valInUSD);
  else if (target === "GBP") return Math.round(valInUSD * 0.80);
  else if (target === "EUR") return Math.round(valInUSD * 0.92);

  return val;
};

export default function CatalogListView({
  isHistoryLoading,
  catalogHistory,
  selectedHistoryId,
  setSelectedHistoryId,
  selectedItemIds,
  setSelectedItemIds,
  toggleItemSelection,
  updateItemLot,
  updateItemCatalogue,
  deleteHistoryItem,
  catalogViewMode,
  setCatalogViewMode,
  currency,
  setCurrency,
  columnWidths,
  setColumnWidths,

  handleResizeStart,
  lotNumberInput,
  lotTitleInput,
  aiProposingLot,
  handleLotNumberInputChange,
  handleLotTitleInputChange,
  updateHistory,
  draggedIndex,
  dragOverIndex,
  handleHistoryDragStart,
  handleHistoryDragOver,
  handleHistoryDragEnd,
  handleHistoryDrop,
  isGroupedByLot,
  onLoadHistoryItem,
  catalogs,
  activeCatalogId,
  onSwitchCatalog,
  onRenameCatalog,
  onDeleteCatalog,
  createNewCatalog,
  updateMultipleItemsCatalogue,
  onNavigate,
}: CatalogListViewProps) {
  const currentCatalog = catalogs.find((c) => c.id === activeCatalogId);

  const [localCatalogNames, setLocalCatalogNames] = React.useState<Record<string, string>>({});
  const [isSavingRename, setIsSavingRename] = React.useState(false);
  const [renameError, setRenameError] = React.useState<string | null>(null);

  const [newCatalogNameInput, setNewCatalogNameInput] = React.useState("");
  const [isCreatingCatalog, setIsCreatingCatalog] = React.useState(false);
  const [isDeletingCatalog, setIsDeletingCatalog] = React.useState(false);
  const [selectedCatalogueFilter, setSelectedCatalogueFilter] = React.useState<string>("all");

  const handleInlineRename = async (catalogId: string, newName: string) => {
    if (!newName.trim()) return;
    const cat = catalogs.find(c => c.id === catalogId);
    if (cat && cat.name === newName.trim()) {
      setLocalCatalogNames(prev => {
        const copy = { ...prev };
        delete copy[catalogId];
        return copy;
      });
      return;
    }
    setIsSavingRename(true);
    setRenameError(null);
    try {
      await onRenameCatalog(catalogId, catalogId, newName.trim());
      setLocalCatalogNames(prev => {
        const copy = { ...prev };
        delete copy[catalogId];
        return copy;
      });
    } catch (err: any) {
      setRenameError(err.message || "Failed to rename catalogue.");
      alert(err.message || "Failed to rename catalogue.");
    } finally {
      setIsSavingRename(false);
    }
  };

  const handleInlineDelete = async (catalogId: string, catalogName: string) => {
    const isConfirmed = window.confirm(
      `Are you sure you want to delete the catalogue "${catalogName}"?\n\n(This will delete the catalogue reference. Its associated items will become uncatalogued, but no appraisal data will be deleted.)`
    );
    if (!isConfirmed) return;

    try {
      await onDeleteCatalog(catalogId);
    } catch (err: any) {
      console.error("Failed to delete catalogue:", err);
      alert(err.message || "Failed to delete catalogue.");
    }
  };

  const handleCreateEmptyCatalog = async (name: string) => {
    if (!name.trim()) return;
    setIsCreatingCatalog(true);
    try {
      await createNewCatalog(name.trim());
      setNewCatalogNameInput("");
    } catch (err: any) {
      console.error("Failed to create empty catalogue:", err);
      alert(err.message || "Failed to create empty catalogue.");
    } finally {
      setIsCreatingCatalog(false);
    }
  };

  const handleDeleteCurrentCatalog = async () => {
    const isConfirmed = window.confirm(
      `Are you sure you want to delete the catalogue "${currentCatalog?.name || activeCatalogId}" and all of its ${catalogHistory.length} appraisal records?\nThis operation is permanent and cannot be undone.`
    );
    if (!isConfirmed) return;

    setIsDeletingCatalog(true);
    try {
      await onDeleteCatalog(activeCatalogId);
    } catch (err: any) {
      console.error("Failed to delete catalogue:", err);
      alert(err.message || "Failed to delete catalogue.");
    } finally {
      setIsDeletingCatalog(false);
    }
  };
  const [filterFilename, setFilterFilename] = React.useState("");
  const [filterDate, setFilterDate] = React.useState("");
  const [filterAppraisalMethod, setFilterAppraisalMethod] = React.useState<string>("all");

  const uniqueModels = React.useMemo(() => {
    const models = new Set<string>();
    // Pre-populate all known method names so they always appear in the filter
    models.add("Gemini Standard");
    models.add("Gemini Pro (2.5)");
    models.add("Gemini Pro (Stable)");
    models.add("Gemini 3.1 Pro (Preview)");
    models.add("Gemini Creative");
    models.add("Gemini Strict / Skeptic");
    models.add("Gemini Simplified");
    models.add("Gemini Low Resolution");
    models.add("Gemini Medium Resolution");
    models.add("Gemini (No Aux Scans)");
    models.add("Claude Sonnet (4.6)");
    models.add("Claude Opus (4.8)");
    models.add("Gemini 3-Stage Pipeline");
    models.add("Claude 3-Stage Pipeline");
    models.add("Claude 4-Stage Pipeline");
    models.add("Gemini 4-Stage Pipeline");

    catalogHistory.forEach(item => {
      const approach = item.report.promptVersion || "standard";
      const model = item.report.modelUsed || "gemini-2.5-flash";
      models.add(resolveMethodLabel(approach, model));
    });
    return Array.from(models);
  }, [catalogHistory]);

  const filteredHistory = React.useMemo(() => {
    return catalogHistory.filter((item) => {
      // Catalogue Filter
      if (selectedCatalogueFilter === "uncatalogued") {
        if (item.catalogue_id) return false;
      } else if (selectedCatalogueFilter !== "all") {
        if (item.catalogue_id !== selectedCatalogueFilter) return false;
      }

      // Filename filter (case-insensitive substring match)
      if (filterFilename.trim() !== "") {
        const query = filterFilename.toLowerCase();
        const filename = (item.imageFileName || "").toLowerCase();
        if (!filename.includes(query)) return false;
      }
      
      // Date filter
      if (filterDate !== "") {
        const filterD = new Date(filterDate);
        const itemD = new Date(item.timestamp);
        const match =
          filterD.getFullYear() === itemD.getFullYear() &&
          filterD.getMonth() === itemD.getMonth() &&
          filterD.getDate() === itemD.getDate();
        if (!match) return false;
      }

      // Appraisal Method Filter
      if (filterAppraisalMethod !== "all") {
        const approach = item.report.promptVersion || "standard";
        const model = item.report.modelUsed || "gemini-2.5-flash";
        if (resolveMethodLabel(approach, model) !== filterAppraisalMethod) return false;
      }
      
      return true;
    });
  }, [catalogHistory, selectedCatalogueFilter, filterFilename, filterDate, filterAppraisalMethod]);

  const activeItem =
    filteredHistory.find((item) => item.id === (selectedHistoryId || filteredHistory[0]?.id)) ||
    filteredHistory[0];

  const totalEstimates = React.useMemo(() => {
    let totalLow = 0;
    let totalHigh = 0;
    filteredHistory.forEach((item) => {
      const originalCurrency = item.report.auctionEstimate.currency || "USD";
      const low = item.report.auctionEstimate.lowEstimate || 0;
      const high = item.report.auctionEstimate.highEstimate || 0;
      totalLow += convertValue(low, originalCurrency, currency);
      totalHigh += convertValue(high, originalCurrency, currency);
    });
    return {
      low: totalLow,
      high: totalHigh
    };
  }, [filteredHistory, currency]);

  const allVisibleSelected = React.useMemo(() => {
    return filteredHistory.length > 0 && filteredHistory.every(item => selectedItemIds.includes(item.id));
  }, [filteredHistory, selectedItemIds]);

  const handleToggleSelectAllVisible = () => {
    if (allVisibleSelected) {
      const visibleIds = filteredHistory.map(item => item.id);
      setSelectedItemIds(selectedItemIds.filter(id => !visibleIds.includes(id)));
    } else {
      const visibleIds = filteredHistory.map(item => item.id);
      const union = Array.from(new Set([...selectedItemIds, ...visibleIds]));
      setSelectedItemIds(union);
    }
  };


  const downloadCsvManifest = (catalogueId?: string) => {
    let itemsToExport = [];
    let catalogName = "printmaster_manifest";

    if (catalogueId) {
      itemsToExport = catalogHistory.filter(item => item.catalogue_id === catalogueId);
      const cat = catalogs.find(c => c.id === catalogueId);
      if (cat) {
        // Sanitize catalogue name to keep only alphanumeric chars, underscores, and hyphens
        catalogName = cat.name.trim().replace(/[\s\W]+/g, "_");
      }
    } else {
      itemsToExport = selectedItemIds.length > 0
        ? filteredHistory.filter(item => selectedItemIds.includes(item.id))
        : filteredHistory;
    }

    if (itemsToExport.length === 0) {
      alert("No items found to export.");
      return;
    }

    const headers = [
      "Archive ID",
      "Timestamp",
      "Image Filename",
      "Lot Number",
      "Lot Title",
      "Artist Attribution",
      "Artist Confidence (%)",
      "Artwork Title",
      "Title Confidence (%)",
      "Creation Period",
      "Overall Grade",
      "Signature Status",
      "Low Estimate",
      "High Estimate",
      "Currency",
      "Inferred Dimensions",
      "Visual Description",
      "Historical Context",
      "Appraisal Model",
      "Prompting Type"
    ];

    const escapeCsv = (val: any) => {
      if (val === undefined || val === null) return '""';
      const str = String(val);
      return `"${str.replace(/"/g, '""')}"`;
    };

    const csvRows = [headers.join(",")];
    itemsToExport.forEach(item => {
      const rep = item.report;
      const row = [
        item.id,
        item.timestamp,
        item.imageFileName,
        item.lotNumber || "Unassigned",
        item.lotTitle || "Unassigned",
        rep.likelyArtist,
        rep.artistConfidence,
        rep.artworkTitle,
        rep.titleConfidence,
        rep.creationPeriod,
        rep.conditionNotes.overallGrade,
        rep.conditionNotes.signatureStatus,
        rep.auctionEstimate.lowEstimate,
        rep.auctionEstimate.highEstimate,
        rep.auctionEstimate.currency,
        rep.inferredDimensions || "",
        rep.visualDescription,
        rep.historicalContext,
        rep.modelUsed || "",
        rep.promptVersion || ""
      ].map(escapeCsv).join(",");
      csvRows.push(row);
    });

    const csvString = csvRows.join("\n");
    const blob = new Blob(["\uFEFF" + csvString], { type: "text/csv;charset=utf-8;" });
    const url = URL.createObjectURL(blob);
    const link = document.createElement("a");
    link.setAttribute("href", url);
    const formattedDate = new Date().toISOString().split("T")[0];
    link.setAttribute("download", `${catalogName}_${formattedDate}.csv`);
    document.body.appendChild(link);
    link.click();
    document.body.removeChild(link);
    URL.revokeObjectURL(url);
  };

  if (isHistoryLoading) {
    return (
      <div className="bg-rosebery-card border border-rosebery-border rounded-sm p-12 text-center text-rosebery-muted max-w-sm mx-auto space-y-4 shadow-gallery-soft animate-fadeIn">
        <div className="relative w-10 h-10 mx-auto">
          <div className="absolute inset-0 rounded-full border-4 border-rosebery-border" />
          <div className="absolute inset-0 rounded-full border-4 border-t-[#4C0B2A] animate-spin" />
        </div>
        <p className="text-sm font-semibold text-rosebery-charcoal font-serif">Opening Cabinet...</p>
        <p className="text-xs">Retrieving your archived print appraisal records...</p>
      </div>
    );
  }

  return (
    <div className="space-y-6 animate-fadeIn">
      {/* Page Navigation Shortcut Menu */}
      <div className="flex flex-wrap items-center justify-between gap-4 bg-white border border-rosebery-border rounded-sm p-4 shadow-gallery-soft">
        <div className="flex items-center gap-2">
          <h2 className="text-xs font-mono font-bold text-rosebery-primary uppercase tracking-wider">
            Quick Navigation
          </h2>
        </div>
        <div className="flex flex-wrap items-center gap-2.5">
          <button
            onClick={() => onNavigate("sandbox")}
            className="flex items-center gap-1.5 px-4 py-2 border border-rosebery-border hover:border-rosebery-primary rounded-xs text-xs font-mono font-bold text-rosebery-primary bg-rosebery-cream-bg/20 hover:bg-rosebery-cream-bg transition-colors cursor-pointer"
          >
            <Sparkles className="w-3.5 h-3.5 text-rosebery-primary" />
            <span>New Appraisal</span>
          </button>
          <button
            onClick={() => onNavigate("batch")}
            className="flex items-center gap-1.5 px-4 py-2 border border-rosebery-border hover:border-rosebery-primary rounded-xs text-xs font-mono font-bold text-rosebery-primary bg-rosebery-cream-bg/20 hover:bg-rosebery-cream-bg transition-colors cursor-pointer"
          >
            <Layers className="w-3.5 h-3.5 text-rosebery-primary" />
            <span>Batch Appraisal</span>
          </button>
          <button
            disabled
            className="flex items-center gap-1.5 px-4 py-2 border border-rosebery-primary bg-[#4B0B29] text-white rounded-xs text-xs font-mono font-bold cursor-default"
          >
            <History className="w-3.5 h-3.5" />
            <span>Review Catalogs</span>
          </button>
        </div>
      </div>

      {/* Catalogue Manager & Editor */}
      <div className="bg-rosebery-card border border-rosebery-border rounded-sm p-5 md:p-6 shadow-gallery-soft space-y-4">
        <div className="flex flex-col md:flex-row md:items-center justify-between gap-4 border-b border-rosebery-border pb-3">
          <div>
            <h3 className="text-base font-serif text-rosebery-charcoal font-semibold tracking-wide flex items-center gap-2">
              <Folder className="w-5 h-5 text-rosebery-primary" />
              Catalogue Manager
            </h3>
            <p className="text-xs text-rosebery-muted mt-0.5">
              allocate appraised images to catalogs (active: <strong className="text-rosebery-primary">{currentCatalog?.name || activeCatalogId}</strong>)
            </p>
          </div>
        </div>

        <div className="pt-3 border-t border-rosebery-border/60 space-y-4">
          <div className="space-y-1">
            <label className="text-[9px] font-mono text-rosebery-primary font-bold uppercase tracking-wider block">
              Available Catalogues
            </label>
            <div className="border border-rosebery-border/50 rounded-sm p-3 bg-stone-50/50 space-y-2 max-h-[300px] overflow-y-auto pr-2 scrollbar-thin scrollbar-thumb-stone-200">
              {catalogs.map((cat) => {
                const isCurrentActive = cat.id === activeCatalogId;
                const currentNameValue = localCatalogNames[cat.id] !== undefined ? localCatalogNames[cat.id] : cat.name;
                const count = catalogHistory.filter(item => item.catalogue_id === cat.id).length;
                const isChanged = currentNameValue !== cat.name;

                return (
                  <div key={cat.id} className={`flex items-center gap-3 p-1.5 rounded-sm border transition-all duration-200 ${isCurrentActive ? 'bg-white border-rosebery-primary/30 shadow-xs' : 'bg-transparent border-transparent hover:bg-stone-100/30'}`}>
                    <label className="flex items-center justify-center cursor-pointer p-1" title="Set as active catalogue">
                      <input
                        type="radio"
                        name="activeCatalogSelector"
                        checked={isCurrentActive}
                        onChange={() => onSwitchCatalog(cat.id)}
                        className="w-3.5 h-3.5 text-rosebery-primary border-stone-300 focus:ring-rosebery-primary cursor-pointer accent-[#4C0B2A]"
                      />
                    </label>
                    <div className="flex-1 flex items-center gap-2">
                      <input
                        type="text"
                        value={currentNameValue}
                        onChange={(e) => setLocalCatalogNames(prev => ({ ...prev, [cat.id]: e.target.value }))}
                        onKeyDown={(e) => {
                          if (e.key === "Enter") {
                            e.preventDefault();
                            handleInlineRename(cat.id, currentNameValue);
                          }
                        }}
                        onBlur={() => handleInlineRename(cat.id, currentNameValue)}
                        className="flex-1 bg-transparent hover:bg-stone-50/30 focus:bg-white text-xs border border-transparent focus:border-rosebery-border rounded-sm px-2 py-1 outline-none text-rosebery-charcoal font-sans transition-colors"
                        title="Edit catalogue name inline"
                      />
                      {isChanged && (
                        <button
                          type="button"
                          onClick={() => handleInlineRename(cat.id, currentNameValue)}
                          disabled={isSavingRename}
                          className="p-1 rounded bg-rosebery-primary text-white hover:bg-[#5E1236] transition-colors cursor-pointer"
                          title="Save changes"
                        >
                          <Check className="w-3.5 h-3.5" />
                        </button>
                      )}
                      <span className="text-[10px] text-rosebery-muted font-mono whitespace-nowrap bg-stone-100/60 border border-stone-200/40 rounded-xs px-1.5 py-0.5 mr-1">
                        {count} {count === 1 ? 'item' : 'items'}
                      </span>
                      <button
                        type="button"
                        onClick={() => downloadCsvManifest(cat.id)}
                        className="p-1 text-stone-400 hover:text-rosebery-primary hover:bg-stone-100 rounded transition-colors cursor-pointer flex items-center justify-center"
                        title="Download CSV manifest for this catalogue"
                      >
                        <Download className="w-3.5 h-3.5" />
                      </button>
                      <button
                        type="button"
                        onClick={() => handleInlineDelete(cat.id, cat.name)}
                        className="p-1 text-stone-400 hover:text-red-600 hover:bg-stone-100 rounded transition-colors cursor-pointer flex items-center justify-center"
                        title="Delete catalogue reference"
                      >
                        <Trash2 className="w-3.5 h-3.5" />
                      </button>
                    </div>
                  </div>
                );
              })}

              {/* Inline Add New Catalogue Row at the bottom */}
              <div className="flex items-center gap-3 p-1.5 rounded-sm border border-dashed border-stone-300 bg-[#F7F6F4]/80">
                <div className="w-3.5 h-3.5 flex items-center justify-center text-stone-400 font-bold select-none text-xs ml-1">
                  +
                </div>
                <div className="flex-1 flex items-center gap-2">
                  <input
                    type="text"
                    placeholder="Add new catalogue (type name & press Enter)..."
                    value={newCatalogNameInput}
                    onChange={(e) => setNewCatalogNameInput(e.target.value)}
                    onKeyDown={(e) => {
                      if (e.key === "Enter") {
                        e.preventDefault();
                        handleCreateEmptyCatalog(newCatalogNameInput);
                      }
                    }}
                    disabled={isCreatingCatalog}
                    className="flex-1 bg-transparent placeholder:text-stone-400 hover:bg-stone-200/20 focus:bg-white text-xs border border-transparent focus:border-rosebery-border rounded-sm px-2 py-1 outline-none text-rosebery-charcoal font-sans transition-colors"
                  />
                  {newCatalogNameInput.trim() && (
                    <button
                      type="button"
                      onClick={() => handleCreateEmptyCatalog(newCatalogNameInput)}
                      disabled={isCreatingCatalog}
                      className="p-1 rounded bg-stone-500 text-white hover:bg-stone-600 transition-colors cursor-pointer"
                      title="Create new catalogue"
                    >
                      {isCreatingCatalog ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <Check className="w-3.5 h-3.5" />}
                    </button>
                  )}
                </div>
              </div>
            </div>
          </div>
          {renameError && (
            <p className="text-[11px] font-mono text-red-600 mt-1">{renameError}</p>
          )}
        </div>
      </div>

      {/* Archive overview banner / Image Database Section */}
      <div className="bg-rosebery-card border border-rosebery-border rounded-sm p-5 md:p-6 shadow-gallery-soft space-y-5">
        <div className="flex flex-col md:flex-row md:items-center justify-between gap-4 border-b border-rosebery-border pb-4">
          <div>
            <h2 className="text-xl font-serif text-rosebery-charcoal tracking-wide font-semibold">image database</h2>
            <p className="text-xs text-rosebery-muted mt-1">
              Please select one or more images from the database below to group them into custom lots, export CSVs, or run actions.
            </p>
          </div>
          <div className="flex flex-col sm:flex-row items-start sm:items-center gap-4 shrink-0">
            {/* Global Currency Preference Selector */}
            <div className="flex items-center gap-2 border border-rosebery-border bg-stone-50 px-3 py-1 rounded-sm shadow-xs">
              <span className="text-[10px] font-mono text-rosebery-muted uppercase tracking-wider font-semibold">
                Currency:
              </span>
              <div className="flex border border-rosebery-border rounded-xs overflow-hidden bg-rosebery-card">
                {(["USD", "GBP", "EUR"] as const).map((curr) => (
                  <button
                    key={curr}
                    type="button"
                    onClick={() => setCurrency(curr)}
                    className={`px-2 py-0.5 text-[10px] font-mono transition-colors cursor-pointer ${
                      currency === curr
                        ? "bg-rosebery-primary text-white font-bold"
                        : "text-rosebery-muted hover:text-rosebery-primary hover:bg-rosebery-cream-bg"
                    }`}
                  >
                    {curr}
                  </button>
                ))}
              </div>
            </div>

            <div className="flex flex-col items-start sm:items-end gap-1">
              <div className="text-xs font-mono text-rosebery-primary uppercase tracking-wider bg-stone-50 px-3.5 py-1.5 border border-rosebery-border rounded-sm font-semibold">
                {filteredHistory.length === catalogHistory.length 
                  ? (catalogHistory.length === 0 ? "Empty Database" : `${catalogHistory.length} Total Masterpieces`)
                  : `${filteredHistory.length} of ${catalogHistory.length} Filtered`}
              </div>
              {filteredHistory.length > 0 && (
                <span className="text-[10px] font-mono text-stone-500 uppercase tracking-wider">
                  Est. Total Value: <strong className="text-rosebery-charcoal">{getCurrencySymbol(currency)}{totalEstimates.low.toLocaleString()} - {getCurrencySymbol(currency)}{totalEstimates.high.toLocaleString()}</strong>
                </span>
              )}
            </div>
          </div>
        </div>

        {/* Filters Row */}
        <div className="grid grid-cols-1 sm:grid-cols-4 gap-4 pt-1">
          {/* 1. Catalogue ID Filter */}
          <div className="space-y-1">
            <label className="text-[10px] font-mono text-rosebery-primary font-bold uppercase tracking-wider block">
              Filter by Catalogue
            </label>
            <select
              value={selectedCatalogueFilter}
              onChange={(e) => setSelectedCatalogueFilter(e.target.value)}
              className="w-full bg-white border border-rosebery-border rounded-xs px-3 py-2 text-xs text-rosebery-charcoal outline-none focus:border-rosebery-primary font-serif cursor-pointer"
            >
              <option value="all">Show All Items</option>
              <option value="uncatalogued">Uncatalogued Items</option>
              {catalogs.map((cat) => (
                <option key={cat.id} value={cat.id}>
                  {cat.name}
                </option>
              ))}
            </select>
          </div>

          {/* 2. Filename Text Search Filter */}
          <div className="space-y-1">
            <label className="text-[10px] font-mono text-rosebery-primary font-bold uppercase tracking-wider block">
              Search Image Filename
            </label>
            <input
              type="text"
              placeholder="Type filename substring..."
              value={filterFilename}
              onChange={(e) => setFilterFilename(e.target.value)}
              className="w-full bg-white border border-rosebery-border rounded-xs px-3 py-2 text-xs text-rosebery-charcoal outline-none focus:border-rosebery-primary placeholder:text-stone-400 font-sans"
            />
          </div>

          {/* 3. Upload Date Filter */}
          <div className="space-y-1">
            <label className="text-[10px] font-mono text-rosebery-primary font-bold uppercase tracking-wider block">
              Filter by Image Upload Date
            </label>
            <div className="flex gap-1.5 items-center">
              <input
                type="date"
                value={filterDate}
                onChange={(e) => setFilterDate(e.target.value)}
                className="w-full bg-white border border-rosebery-border rounded-xs px-3 py-2 text-xs text-rosebery-charcoal outline-none focus:border-rosebery-primary font-mono cursor-pointer"
              />
              {filterDate && (
                <button
                  type="button"
                  onClick={() => setFilterDate("")}
                  className="px-2 py-2 text-xs text-rosebery-muted hover:text-rosebery-primary font-mono font-bold bg-stone-100 hover:bg-stone-200/60 rounded-xs border border-rosebery-border cursor-pointer transition-colors"
                  title="Clear date filter"
                >
                  Clear
                </button>
              )}
            </div>
          </div>

          {/* 4. Appraisal Method Filter */}
          <div className="space-y-1">
            <label className="text-[10px] font-mono text-rosebery-primary font-bold uppercase tracking-wider block">
              Filter by Appraisal Method
            </label>
            <select
              value={filterAppraisalMethod}
              onChange={(e) => setFilterAppraisalMethod(e.target.value)}
              className="w-full bg-white border border-rosebery-border rounded-xs px-3 py-2 text-xs text-rosebery-charcoal outline-none focus:border-rosebery-primary font-serif cursor-pointer"
            >
              <option value="all">Show All Methods</option>
              {uniqueModels.map((model) => (
                <option key={model} value={model}>
                  {model}
                </option>
              ))}
            </select>
          </div>
        </div>
      </div>

      {filteredHistory.length > 0 && (
        <div className="bg-rosebery-card border border-rosebery-border rounded-sm p-4 flex flex-col gap-4 shadow-gallery-soft animate-fadeIn">
          {/* Header row with selection info & clear button */}
          <div className="flex flex-col md:flex-row items-center justify-between gap-4 border-b border-rosebery-border/50 pb-3">
            <div className="flex flex-wrap items-center gap-3">
              <span className="text-xs font-serif text-rosebery-muted">
                {selectedItemIds.length > 0 && (
                  <>
                    Active Group Lot:{" "}
                    <strong className="text-rosebery-primary font-mono text-xs font-bold">{selectedItemIds.length}</strong>{" "}
                    items selected for grouping
                  </>
                )}
              </span>

              {selectedItemIds.length > 0 && (
                <button
                  onClick={() => {
                    const updated = catalogHistory.map((item) => {
                      if (selectedItemIds.includes(item.id)) {
                        return { ...item, lotNumber: undefined, lotTitle: undefined };
                      }
                      return item;
                    });
                    updateHistory(updated);
                    setSelectedItemIds([]);
                    handleLotNumberInputChange("");
                    handleLotTitleInputChange("");
                  }}
                  className="text-[10px] uppercase font-mono tracking-wider font-semibold px-2.5 py-1 bg-rosebery-cream-bg text-stone-500 hover:text-red-600 border border-rosebery-border rounded-xs transition-colors cursor-pointer"
                  title="Unassign current active selection lot entirely"
                >
                  Unassign & Clear Group
                </button>
              )}
            </div>

            {/* Layout selector */}
            <div className="flex flex-wrap items-center gap-3.5">
              <div className="flex items-center gap-2 border border-rosebery-border bg-stone-50 px-3.5 py-1.5 rounded-xs">
                <span className="text-[10px] font-mono text-rosebery-muted uppercase tracking-wider font-semibold">
                  Layout:
                </span>
                <div className="flex border border-rosebery-border rounded-xs overflow-hidden bg-white">
                  <button
                    onClick={() => setCatalogViewMode("inspector")}
                    className={`px-2.5 py-0.5 text-[10px] font-mono transition-all font-semibold cursor-pointer ${
                      catalogViewMode === "inspector"
                        ? "bg-rosebery-primary text-white font-bold"
                        : "text-rosebery-muted hover:text-rosebery-primary hover:bg-rosebery-cream-bg"
                    }`}
                    title="Display list explorer & detail view side-by-side"
                  >
                    Inspector
                  </button>
                  <button
                    onClick={() => setCatalogViewMode("tabular")}
                    className={`px-2.5 py-0.5 text-[10px] font-mono transition-all font-semibold cursor-pointer ${
                      catalogViewMode === "tabular"
                        ? "bg-rosebery-primary text-white font-bold"
                        : "text-rosebery-muted hover:text-rosebery-primary hover:bg-rosebery-cream-bg"
                    }`}
                    title="Display records in adjustable tabular list spreadsheet"
                  >
                    Tabular List
                  </button>
                </div>
              </div>


            </div>
          </div>

          {/* Lot grouping creator editing row */}
          <LotCreatorModal
            selectedItemIds={selectedItemIds}
            lotNumberInput={lotNumberInput}
            lotTitleInput={lotTitleInput}
            aiProposingLot={aiProposingLot}
            onLotNumberChange={handleLotNumberInputChange}
            onLotTitleChange={handleLotTitleInputChange}
            onClearSelection={() => setSelectedItemIds([])}
          />
        </div>
      )}

      {catalogHistory.length === 0 ? (
        <div className="bg-rosebery-card border border-rosebery-border rounded-sm p-12 text-center text-rosebery-muted max-w-sm mx-auto space-y-4 shadow-gallery-soft animate-fadeIn">
          <FileText className="w-10 h-10 mx-auto opacity-40 text-rosebery-primary" />
          <div className="space-y-1">
            <p className="text-sm font-semibold text-rosebery-charcoal font-serif">Cabinet is currently empty</p>
            <p className="text-xs">Your appraised masterpiece print coordinates will preserve here.</p>
          </div>
        </div>
      ) : filteredHistory.length === 0 ? (
        <div className="bg-rosebery-card border border-rosebery-border rounded-sm p-12 text-center text-rosebery-muted max-w-sm mx-auto space-y-4 shadow-gallery-soft animate-fadeIn">
          <FileText className="w-10 h-10 mx-auto opacity-40 text-rosebery-primary" />
          <div className="space-y-1">
            <p className="text-sm font-semibold text-rosebery-charcoal font-serif">No matching images found</p>
            <p className="text-xs">Try adjusting your search filters above.</p>
          </div>
        </div>
      ) : catalogViewMode === "tabular" ? (
        <div className="space-y-4 animate-fadeIn">


          {/* 2. Interactive Spreadsheet Table Card */}
          <div className="bg-white border border-rosebery-border rounded-sm shadow-gallery-soft overflow-hidden flex flex-col">
            <div className="overflow-x-auto scrollbar-thin scrollbar-thumb-stone-200">
              <table className="w-full text-left border-collapse table-fixed text-rosebery-charcoal select-text">
                <colgroup>
                  <col style={{ width: `${columnWidths.checkbox}px` }} />
                  <col style={{ width: `${columnWidths.preview}px` }} />
                  <col style={{ width: `${columnWidths.titleArtist}px` }} />
                  <col style={{ width: `${columnWidths.period}px` }} />
                  <col style={{ width: `${columnWidths.technique}px` }} />
                  <col style={{ width: `${columnWidths.lot}px` }} />
                  <col style={{ width: `${columnWidths.valuation}px` }} />
                  <col style={{ width: "90px" }} /> {/* Actions column */}
                </colgroup>
                <thead>
                  <tr className="bg-rosebery-cream-bg border-b border-rosebery-border">
                    {[
                      { key: "checkbox", label: "✓", resizable: false },
                      { key: "preview", label: "Scan Preview", resizable: true },
                      { key: "titleArtist", label: "Artwork Title & Artist Attribution", resizable: true },
                      { key: "period", label: "Creation Period", resizable: true },
                      { key: "technique", label: "Primary Technique", resizable: true },
                      { key: "lot", label: "Lot ID", resizable: true },
                      { key: "valuation", label: "Auction Est. Range", resizable: true },
                      { key: "actions", label: "Actions", resizable: false },
                    ].map((col) => (
                      <th
                        key={col.key}
                        className="relative px-3 py-3 border-r border-rosebery-border font-mono text-[9px] uppercase font-bold tracking-wider text-rosebery-primary select-none text-left"
                      >
                        <div className="flex items-center justify-between">
                          {col.key === "checkbox" ? (
                            <div
                              onClick={handleToggleSelectAllVisible}
                              className="mx-auto flex items-center justify-center cursor-pointer p-1"
                              title={allVisibleSelected ? "Deselect all visible items" : "Select all visible items"}
                            >
                              <div
                                className={`w-3.5 h-3.5 rounded-xs border flex items-center justify-center transition-all ${
                                  allVisibleSelected
                                    ? "bg-rosebery-primary border-rosebery-primary text-white"
                                    : "border-stone-300 hover:border-rosebery-primary bg-white"
                                }`}
                              >
                                {allVisibleSelected && <Check className="w-2.5 h-2.5 stroke-[3]" />}
                              </div>
                            </div>
                          ) : (
                            <span>{col.label}</span>
                          )}
                        </div>
                        {col.resizable && (
                          <div
                            onMouseDown={(e) => {
                              e.preventDefault();
                              handleResizeStart(col.key, e.clientX, columnWidths[col.key]);
                            }}
                            className="absolute top-0 right-0 bottom-0 w-1.5 cursor-col-resize hover:bg-rosebery-primary/40 active:bg-rosebery-primary transition-colors z-20"
                            title="Drag to resize column"
                          />
                        )}
                      </th>
                    ))}
                  </tr>
                </thead>
                <tbody className="divide-y divide-[#E8E2D7]">
                  {filteredHistory.map((item) => {
                    const isSelectedHistoryId =
                      selectedHistoryId === item.id || (!selectedHistoryId && filteredHistory[0].id === item.id);
                    const isCheckedForLot = selectedItemIds.includes(item.id);

                    const originalCurrency = item.report.auctionEstimate.currency || "USD";
                    const low = item.report.auctionEstimate.lowEstimate;
                    const high = item.report.auctionEstimate.highEstimate;

                    const conLow = convertValue(low, originalCurrency, currency);
                    const conHigh = convertValue(high, originalCurrency, currency);

                    return (
                      <tr
                        key={item.id}
                        onClick={() => setSelectedHistoryId(item.id)}
                        className={`group/row transition-colors hover:bg-rosebery-cream-bg/40 cursor-default ${
                          isSelectedHistoryId ? "bg-stone-50 font-medium" : ""
                        }`}
                      >
                        {/* 1. Checkbox cell */}
                        <td className="px-3 py-3 text-center border-r border-rosebery-border">
                          <div
                            onClick={(e) => {
                              e.stopPropagation();
                              toggleItemSelection(item.id);
                            }}
                            className="inline-flex items-center justify-center cursor-pointer p-1"
                          >
                            <div
                              className={`w-3.5 h-3.5 rounded-xs border flex items-center justify-center transition-all ${
                                isCheckedForLot
                                  ? "bg-rosebery-primary border-rosebery-primary text-white"
                                  : "border-stone-300 hover:border-rosebery-primary bg-white"
                              }`}
                            >
                              {isCheckedForLot && <Check className="w-2.5 h-2.5 stroke-[3]" />}
                            </div>
                          </div>
                        </td>

                        {/* 2. Preview cell */}
                        <td className="px-3 py-2 border-r border-rosebery-border">
                          <div className="w-10 h-10 bg-rosebery-cream-bg rounded-sm border border-rosebery-border overflow-hidden flex items-center justify-center p-0.5 mx-auto">
                            <img
                              src={item.imageUrl}
                              alt={item.imageFileName}
                              className="w-full h-full object-contain"
                            />
                          </div>
                        </td>

                        {/* 3. Title & Artist cell */}
                        <td className="px-3 py-3 border-r border-rosebery-border min-w-0">
                          <div
                            className="truncate font-serif font-bold text-xs text-rosebery-charcoal"
                            title={item.report.artworkTitle}
                          >
                            {item.report.artworkTitle}
                          </div>
                          <div
                            className="truncate text-[10.5px] italic text-rosebery-muted mt-0.5 font-serif"
                            title={item.report.likelyArtist}
                          >
                            by {item.report.likelyArtist}
                          </div>
                        </td>

                        {/* 4. Period cell */}
                        <td
                          className="px-3 py-3 border-r border-rosebery-border font-sans text-xs text-rosebery-muted truncate"
                          title={item.report.creationPeriod}
                        >
                          {item.report.creationPeriod}
                        </td>

                        {/* 5. Technique cell */}
                        <td
                          className="px-3 py-3 border-r border-rosebery-border text-xs text-rosebery-muted truncate"
                          title={item.report.techniques[0]?.technique}
                        >
                          {item.report.techniques[0]?.technique || "N/A"}
                        </td>

                        {/* 6. Lot cell */}
                        <td className="px-3 py-3 border-r border-rosebery-border text-xs">
                          <input
                            type="text"
                            value={item.lotNumber || ""}
                            placeholder="None (Edit)"
                            onChange={(e) =>
                              updateItemLot(item.id, e.target.value, item.lotTitle || "Lot Collection")
                            }
                            onClick={(e) => e.stopPropagation()}
                            className="w-full bg-transparent hover:bg-rosebery-cream-bg/80 focus:bg-white text-xs border border-transparent focus:border-rosebery-border rounded-xs px-1.5 py-0.5 outline-none font-mono text-rosebery-primary font-bold"
                          />
                        </td>

                        {/* 7. Valuation cell */}
                        <td className="px-3 py-3 border-r border-rosebery-border">
                          <span className="font-mono font-bold text-xs text-rosebery-charcoal">
                            {getCurrencySymbol(currency)}
                            {conLow.toLocaleString()} - {getCurrencySymbol(currency)}
                            {conHigh.toLocaleString()}
                          </span>
                        </td>

                        {/* Actions cell */}
                        <td className="px-3 py-3 text-center">
                          <button
                            onClick={(e) => {
                              e.stopPropagation();
                              deleteHistoryItem(item.id, e);
                            }}
                            className="text-stone-400 hover:text-red-600 p-1 rounded hover:bg-rosebery-cream-bg"
                            title="Delete Record"
                          >
                            <Trash2 className="w-3.5 h-3.5" />
                          </button>
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          </div>

          {/* Sub-Panel: Detailed Selected Report View inside tabular mode */}
          <div className="bg-rosebery-card border border-rosebery-border p-5 rounded-sm shadow-gallery-soft space-y-4">
            <div className="border-b border-rosebery-border pb-2 flex items-center justify-between">
              <span className="text-[10px] font-mono uppercase tracking-widest text-rosebery-primary font-bold">
                Item Summary
              </span>
              <span className="text-[9px] font-mono text-rosebery-muted uppercase">Lot & Support Analysis</span>
            </div>

            <div className="grid grid-cols-1 md:grid-cols-12 gap-6 items-start">
              {/* Summary Block Column */}
              <div className="md:col-span-8 space-y-4">
                <div className="flex flex-col sm:flex-row sm:items-start justify-between gap-2.5">
                  <div>
                    <h3 className="text-base font-serif font-bold text-rosebery-charcoal">{activeItem.report.artworkTitle}</h3>
                    <p className="text-xs text-rosebery-muted mt-0.5">
                      By <strong className="text-rosebery-primary">{activeItem.report.likelyArtist}</strong> •{" "}
                      {activeItem.report.creationPeriod}
                    </p>
                  </div>
                  <button
                    onClick={() => onLoadHistoryItem(activeItem)}
                    className="text-xs text-rosebery-primary hover:text-white hover:bg-rosebery-primary border border-rosebery-primary px-4 py-2 rounded-sm uppercase tracking-wider font-bold transition-all cursor-pointer flex items-center gap-1.5 shadow-xs shrink-0 self-start sm:self-center"
                  >
                    <FileText className="w-3.5 h-3.5" />
                    Open Detailed Appraisal
                  </button>
                </div>

                <div className="grid grid-cols-1 sm:grid-cols-3 gap-4">
                  <div className="bg-stone-50 border border-rosebery-border/70 p-3 rounded-xs">
                    <span className="text-[9px] font-mono text-rosebery-primary font-bold uppercase tracking-wider block mb-1">
                      Grade & Integrity
                    </span>
                    <span className="text-xs font-bold text-rosebery-charcoal block">
                      ★ {activeItem.report.conditionNotes.overallGrade} Grade
                    </span>
                    <span className="text-[10px] text-rosebery-muted block mt-0.5 truncate">
                      {activeItem.report.conditionNotes.signatureStatus}
                    </span>
                  </div>
                  <div className="bg-stone-50 border border-rosebery-border/70 p-3 rounded-xs">
                    <span className="text-[9px] font-mono text-rosebery-primary font-bold uppercase tracking-wider block mb-1">
                      Deduced Technique
                    </span>
                    <span className="text-xs font-bold text-rosebery-charcoal block truncate">
                      {activeItem.report.techniques[0]?.technique || "N/A"}
                    </span>
                    <span className="text-[10px] text-rosebery-muted block mt-0.5">
                      {activeItem.report.techniques[0]?.confidence || 0}% confidence match
                    </span>
                  </div>
                  <div className="bg-stone-50 border border-rosebery-border/70 p-3 rounded-xs">
                    <span className="text-[9px] font-mono text-rosebery-primary font-bold uppercase tracking-wider block mb-1">
                      Lot Allocation
                    </span>
                    <div className="flex items-center gap-1.5 mt-0.5">
                      <span className="bg-rosebery-primary/15 text-rosebery-primary font-mono font-bold text-[9px] px-1.5 py-0.5 rounded-sm border border-rosebery-primary/20">
                        {activeItem.lotNumber || "None Assigned"}
                      </span>
                    </div>
                  </div>
                </div>

                {activeItem.report.editionSizeAndPrintNumber && (
                  <div className="bg-stone-50 border border-rosebery-border/70 p-3.5 rounded-xs flex items-start gap-2.5 border-l-2 border-l-[#4C0B2A]">
                    <Hash className="w-3.5 h-3.5 text-rosebery-primary shrink-0 mt-0.5" />
                    <div className="space-y-0.5">
                      <span className="text-[9px] font-mono text-rosebery-primary tracking-wider uppercase font-extrabold block">
                        Edition Size & Print Numbering Status
                      </span>
                      <p className="text-[11.5px] italic text-rosebery-muted leading-relaxed font-serif">
                        {activeItem.report.editionSizeAndPrintNumber}
                      </p>
                    </div>
                  </div>
                )}
              </div>

              {/* Interactive Lot Title / Category assignment form */}
              <div className="md:col-span-4 bg-stone-50 border border-rosebery-border p-4 rounded-sm space-y-3 shadow-xs">
                <span className="text-[9px] font-mono text-rosebery-primary tracking-wider uppercase block border-b border-rosebery-border pb-1 font-extrabold">
                  ⚙️ Rapid Lot Formulator
                </span>
                <div className="space-y-2">
                  <div className="space-y-1">
                    <label className="text-[9px] font-mono text-stone-500 uppercase block font-semibold">
                      Lot Number:
                    </label>
                    <input
                      type="text"
                      value={activeItem.lotNumber || ""}
                      onChange={(e) => updateItemLot(activeItem.id, e.target.value, activeItem.lotTitle || "")}
                      placeholder="E.g. Lot 101"
                      className="w-full bg-white border border-rosebery-border rounded-sm text-xs px-2.5 py-1 text-rosebery-charcoal outline-none focus:ring-1 focus:ring-rosebery-primary/30 focus:border-rosebery-primary"
                    />
                  </div>
                  <div className="space-y-1">
                    <label className="text-[9px] font-mono text-stone-500 uppercase block font-semibold">
                      Lot Category / Title:
                    </label>
                    <input
                      type="text"
                      value={activeItem.lotTitle || ""}
                      onChange={(e) => updateItemLot(activeItem.id, activeItem.lotNumber || "", e.target.value)}
                      placeholder="E.g. Classic European Engravings"
                      className="w-full bg-white border border-rosebery-border rounded-sm text-xs px-2.5 py-1 text-rosebery-charcoal outline-none focus:ring-1 focus:ring-rosebery-primary/30 focus:border-rosebery-primary"
                    />
                  </div>
                  <div className="space-y-1">
                    <label className="text-[9px] font-mono text-stone-500 uppercase block font-semibold">
                      Catalogue:
                    </label>
                    <select
                      value={activeItem.catalogue_id || ""}
                      onChange={(e) => {
                        const val = e.target.value === "" ? null : e.target.value;
                        updateItemCatalogue(activeItem.id, val);
                      }}
                      className="w-full bg-white border border-rosebery-border rounded-sm text-xs px-2.5 py-1 text-rosebery-charcoal outline-none focus:ring-1 focus:ring-rosebery-primary/30 focus:border-rosebery-primary font-serif cursor-pointer"
                    >
                      <option value="">None / Uncatalogued</option>
                      {catalogs.map((cat) => (
                        <option key={cat.id} value={cat.id}>
                          {cat.name}
                        </option>
                      ))}
                    </select>
                  </div>
                </div>
              </div>
            </div>
          </div>
        </div>
      ) : (
        <div className="grid grid-cols-1 lg:grid-cols-4 gap-8">
          {/* Catalog items sidebar with either Flat or grouped list */}
          <HistorySidebar
            catalogHistory={filteredHistory}
            fullHistory={catalogHistory}
            selectedHistoryId={selectedHistoryId}
            setSelectedHistoryId={setSelectedHistoryId}
            selectedItemIds={selectedItemIds}
            setSelectedItemIds={setSelectedItemIds}
            toggleItemSelection={toggleItemSelection}
            isGroupedByLot={isGroupedByLot}
            draggedIndex={draggedIndex}
            dragOverIndex={dragOverIndex}
            handleHistoryDragStart={handleHistoryDragStart}
            handleHistoryDragOver={handleHistoryDragOver}
            handleHistoryDragEnd={handleHistoryDragEnd}
            handleHistoryDrop={handleHistoryDrop}
            deleteHistoryItem={deleteHistoryItem}
            updateHistory={updateHistory}
            catalogs={catalogs}
            updateMultipleItemsCatalogue={updateMultipleItemsCatalogue}
          />

          {/* Catalog detail visualizer */}
          <div className="lg:col-span-3 space-y-6">


            {/* LOT GROUP CORRESPONDENCE CONTROLLER - Create Lots, Assign Images */}
            <div className="bg-rosebery-card border border-rosebery-border p-5 rounded-sm space-y-4 shadow-gallery-soft">
              <div className="border-b border-rosebery-border pb-2.5 flex items-center justify-between">
                <h3 className="text-xs font-mono text-rosebery-primary uppercase tracking-widest font-bold flex items-center gap-1.5">
                  <Folder className="w-4 h-4 text-rosebery-primary" />
                  Lot Allocation & Cataloguing Details
                </h3>
                <span className="text-[10px] font-mono text-rosebery-muted uppercase tracking-tight">
                  Auction terminologies
                </span>
              </div>

               <div className="grid grid-cols-1 sm:grid-cols-3 gap-4">
                <div className="space-y-1.5">
                  <label className="text-[10px] font-mono text-rosebery-primary font-semibold uppercase tracking-wider block">
                    Lot ID/Number (e.g. "Lot 101")
                  </label>
                  <input
                    type="text"
                    placeholder="E.g. Lot 101, Lot 45..."
                    value={activeItem.lotNumber || ""}
                    onChange={(e) => updateItemLot(activeItem.id, e.target.value, activeItem.lotTitle || "")}
                    className="w-full bg-rosebery-cream-bg border border-rosebery-border focus:border-rosebery-primary focus:bg-rosebery-card rounded-sm px-3.5 py-2 text-xs text-rosebery-charcoal outline-hidden placeholder:text-stone-400 font-mono transition-colors"
                  />
                </div>

                <div className="space-y-1.5">
                  <label className="text-[10px] font-mono text-rosebery-primary font-semibold uppercase tracking-wider block">
                    Lot Category / Catalogue Title Context
                  </label>
                  <input
                    type="text"
                    placeholder="E.g. Post-War Japanese woodcuts, Fine Lithography..."
                    value={activeItem.lotTitle || ""}
                    onChange={(e) => updateItemLot(activeItem.id, activeItem.lotNumber || "", e.target.value)}
                    className="w-full bg-rosebery-cream-bg border border-rosebery-border focus:border-rosebery-primary focus:bg-rosebery-card rounded-sm px-3.5 py-2 text-xs text-rosebery-charcoal outline-hidden placeholder:text-stone-400 font-mono transition-colors"
                  />
                </div>

                <div className="space-y-1.5">
                  <label className="text-[10px] font-mono text-rosebery-primary font-semibold uppercase tracking-wider block">
                    Catalogue Allocation
                  </label>
                  <select
                    value={activeItem.catalogue_id || ""}
                    onChange={(e) => {
                      const val = e.target.value === "" ? null : e.target.value;
                      updateItemCatalogue(activeItem.id, val);
                    }}
                    className="w-full bg-rosebery-cream-bg border border-rosebery-border focus:border-rosebery-primary focus:bg-rosebery-card rounded-sm px-3.5 py-2 text-xs text-rosebery-charcoal outline-hidden font-serif cursor-pointer transition-colors"
                  >
                    <option value="">None / Uncatalogued</option>
                    {catalogs.map((cat) => (
                      <option key={cat.id} value={cat.id}>
                        {cat.name}
                      </option>
                    ))}
                  </select>
                </div>
              </div>
            </div>

            {/* Short Summary Representation of the Highlighted Print Record with integrated image */}
            <div className="bg-rosebery-card border border-rosebery-border rounded-sm p-5 shadow-xs space-y-5">
              <div className="flex flex-col sm:flex-row items-center sm:items-stretch gap-5 border-b border-rosebery-border pb-4">
                {/* Embedded Visual Presentation */}
                <div className="bg-stone-50 border border-rosebery-border rounded-xs p-3 flex items-center justify-center h-[160px] w-full sm:w-[160px] shrink-0 overflow-hidden relative">
                  <img
                    src={activeItem.imageUrl}
                    alt={activeItem.report.artworkTitle}
                    className="max-h-[140px] max-w-full object-contain rounded-xs border border-rosebery-border shadow-xs bg-white p-1.5"
                  />
                </div>

                {/* Core artwork details summary metadata */}
                <div className="flex flex-col justify-between py-1 text-center sm:text-left space-y-3 w-full">
                  <div className="flex flex-col sm:flex-row sm:items-start justify-between gap-3 text-left">
                    <div className="text-center sm:text-left">
                      <span className="text-[10px] font-mono text-rosebery-muted uppercase tracking-wider block">
                        Currently Highlighted Artistry
                      </span>
                      <h3 className="font-serif font-bold text-rosebery-charcoal text-base leading-tight mt-1">
                        {activeItem.report.artworkTitle}
                      </h3>
                      <p className="text-xs text-rosebery-muted font-mono mt-1 text-center sm:text-left">
                        By <span className="font-bold text-rosebery-primary">{activeItem.report.likelyArtist}</span> •{" "}
                        {activeItem.report.creationPeriod}
                      </p>
                      {activeItem.report.editionSizeAndPrintNumber && (
                        <p className="text-[11.5px] text-rosebery-muted mt-1.5 text-center sm:text-left">
                          <span className="font-mono text-[9px] uppercase tracking-wider text-rosebery-primary font-bold">Edition Info:</span>{" "}
                          <span className="italic font-serif">{activeItem.report.editionSizeAndPrintNumber}</span>
                        </p>
                      )}
                    </div>
                    <button
                      onClick={() => onLoadHistoryItem(activeItem)}
                      className="text-xs text-rosebery-primary hover:text-white hover:bg-rosebery-primary border border-rosebery-primary px-4 py-2 rounded-sm uppercase tracking-wider font-bold transition-all cursor-pointer flex items-center gap-1.5 shadow-xs shrink-0 self-center"
                    >
                      <FileText className="w-3.5 h-3.5" />
                      Open Detailed Appraisal
                    </button>
                  </div>

                  <div className="text-[9px] font-mono text-stone-400 capitalize text-center sm:text-left">
                    File Ref: {activeItem.imageFileName} • {activeItem.imageSize || "N/A"}
                  </div>
                </div>
              </div>

              <div className="grid grid-cols-1 md:grid-cols-3 gap-5">
                {/* 1. PRINTING TECHNIQUE */}
                <div className="bg-stone-50 border border-rosebery-border p-4 rounded-sm flex flex-col justify-between space-y-3">
                  <div>
                    <span className="text-[10px] font-mono text-rosebery-primary font-bold tracking-wider uppercase block mb-1">
                      Printing Technique
                    </span>
                    <h4 className="font-serif font-bold text-rosebery-charcoal text-xs leading-snug">
                      {activeItem.report.techniques[0]?.technique || "Not Specified"}
                    </h4>
                    {activeItem.report.techniques[0]?.confidence !== undefined && (
                      <span className="text-[9px] font-mono text-emerald-800 bg-emerald-50 px-1.5 py-0.5 border border-emerald-100 rounded-sm inline-block mt-1.5">
                        {activeItem.report.techniques[0].confidence}% Confidence
                      </span>
                    )}
                  </div>
                  <p className="text-[11px] text-rosebery-muted leading-relaxed line-clamp-3 italic">
                    {activeItem.report.techniques[0]?.description || "Detail not logged"}
                  </p>
                </div>

                {/* 2. CONDITION STATE */}
                <div className="bg-stone-50 border border-rosebery-border p-4 rounded-sm flex flex-col justify-between space-y-3">
                  <div>
                    <span className="text-[10px] font-mono text-rosebery-primary font-bold tracking-wider uppercase block mb-1">
                      Condition State
                    </span>
                    <div className="flex flex-wrap items-center gap-1.5 mt-1">
                      <span
                        className={`text-[9px] uppercase font-mono font-bold px-1.5 py-0.5 rounded-sm border ${
                          activeItem.report.conditionNotes.overallGrade === "Mint" ||
                          activeItem.report.conditionNotes.overallGrade === "Excellent"
                            ? "bg-emerald-50 border-emerald-200 text-emerald-800"
                            : activeItem.report.conditionNotes.overallGrade === "Good"
                              ? "bg-amber-50 border-amber-200 text-amber-800"
                              : "bg-red-50 border-red-200 text-red-800"
                        }`}
                      >
                        {activeItem.report.conditionNotes.overallGrade}
                      </span>
                      <span
                        className="text-[10px] text-rosebery-muted font-mono line-clamp-1"
                        title={activeItem.report.conditionNotes.signatureStatus}
                      >
                        • {activeItem.report.conditionNotes.signatureStatus}
                      </span>
                    </div>
                  </div>
                  <p className="text-[11px] text-rosebery-muted leading-relaxed line-clamp-3">
                    {activeItem.report.conditionNotes.analysisDetails ||
                      activeItem.report.conditionNotes.mattingAndMargins}
                  </p>
                </div>

                {/* 3. PRICE ESTIMATE */}
                <div className="bg-stone-50 border border-rosebery-border p-4 rounded-sm flex flex-col justify-between space-y-3">
                  <div>
                    <span className="text-[10px] font-mono text-rosebery-primary font-bold tracking-wider uppercase block mb-1">
                      Price Estimate
                    </span>
                    {(() => {
                      const originalCurrency = activeItem.report.auctionEstimate.currency || "USD";
                      const low = activeItem.report.auctionEstimate.lowEstimate;
                      const high = activeItem.report.auctionEstimate.highEstimate;

                      const convertedLow = convertValue(low, originalCurrency, currency);
                      const convertedHigh = convertValue(high, originalCurrency, currency);

                      return (
                        <div className="mt-1">
                          <div className="text-sm font-mono font-bold text-rosebery-charcoal">
                            {getCurrencySymbol(currency)}
                            {convertedLow.toLocaleString()} - {getCurrencySymbol(currency)}
                            {convertedHigh.toLocaleString()}
                          </div>
                          <span className="text-[8px] font-mono text-rosebery-muted block mt-0.5 uppercase tracking-tight">
                            Converted from original {originalCurrency}
                          </span>
                        </div>
                      );
                    })()}
                  </div>
                  <p className="text-[11px] text-rosebery-muted leading-relaxed line-clamp-3">
                    {activeItem.report.auctionEstimate.valuationContext}
                  </p>
                </div>
              </div>


            </div>
          </div>
        </div>
      )}
    </div>
  );
}
