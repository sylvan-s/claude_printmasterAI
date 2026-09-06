import React, { useState, useRef, useMemo } from "react";
import { 
  FolderOpen, 
  Play, 
  Loader2, 
  Scissors,
  Database,
  AlertCircle
} from "lucide-react";
import { PrintAnalysisReport, AnalysisHistoryItem, CatalogMetadata } from "../types";
import { resolveMethodLabel } from "../utils/resolveMethodLabel";
import { cropImageCanvas } from "../utils/cropImageCanvas";

interface BatchProcessorProps {
  itemDatabase: AnalysisHistoryItem[];
  updateHistory: (newHistory: AnalysisHistoryItem[]) => Promise<AnalysisHistoryItem[]>;
  currency: "USD" | "GBP" | "EUR";
  appraisalMethod: string;
  setAppraisalMethod: (val: string) => void;
  appraisalMethods: any[];
}

const resizeImageIfNeeded = async (
  base64Data: string,
  quality: "original" | "medium" | "low"
): Promise<string> => {
  if (quality === "original") return base64Data;
  const maxDim = quality === "low" ? 512 : 1024;
  return new Promise((resolve) => {
    const img = new Image();
    img.onload = () => {
      let w = img.width;
      let h = img.height;
      if (w <= maxDim && h <= maxDim) {
        resolve(base64Data);
        return;
      }
      if (w > h) {
        h = Math.round((h * maxDim) / w);
        w = maxDim;
      } else {
        w = Math.round((w * maxDim) / h);
        h = maxDim;
      }
      const canvas = document.createElement("canvas");
      canvas.width = w;
      canvas.height = h;
      const ctx = canvas.getContext("2d");
      if (ctx) {
        ctx.imageSmoothingEnabled = true;
        ctx.imageSmoothingQuality = "high";
        ctx.drawImage(img, 0, 0, w, h);
        resolve(canvas.toDataURL("image/jpeg", 0.8));
      } else {
        resolve(base64Data);
      }
    };
    img.onerror = () => resolve(base64Data);
    img.src = base64Data;
  });
};

interface BatchFile {
  id: string;
  name: string;
  sourceType: "local" | "upload";
  localPath?: string; // used for local directory files
  fileObject?: File;   // used for browser upload files
  status: "pending" | "detecting" | "splitting" | "appraising" | "completed" | "failed" | "already_appraised";
  error?: string;
  splitItemsCount?: number;
  lotNumber?: string;
  lotTitle?: string;
  artworks?: ProcessedArtwork[];
  thumbnailUrl?: string;
  timestamp?: string;
  methodUsed?: string;
}

const isModelUnavailableError = (errorMsg: string): boolean => {
  if (!errorMsg) return false;
  const msg = errorMsg.toLowerCase();
  return (
    msg.includes("quota") ||
    msg.includes("rate limit") ||
    msg.includes("429") ||
    msg.includes("503") ||
    msg.includes("504") ||
    msg.includes("resourceexhausted") ||
    msg.includes("resource_exhausted") ||
    msg.includes("service unavailable") ||
    msg.includes("overloaded") ||
    msg.includes("unavailable") ||
    msg.includes("fetch failed") ||
    msg.includes("model is overloaded")
  );
};

// Helper: Extract original filename prefix
const extractOriginalFilename = (fileName: string): string => {
  if (!fileName) return "";
  const primaryIdx = fileName.indexOf("_Primary_Artwork");
  if (primaryIdx !== -1) {
    return fileName.substring(0, primaryIdx);
  }
  const artworkIdx = fileName.indexOf("_Artwork_");
  if (artworkIdx !== -1) {
    return fileName.substring(0, artworkIdx);
  }
  return fileName;
};

interface ProcessedArtwork {
  label: string;
  imagePreview: string; // cropped base64
  status: "pending" | "appraising" | "completed" | "failed";
  error?: string;
  report?: PrintAnalysisReport;
}

export default function BatchProcessor({ 
  itemDatabase, 
  updateHistory, 
  currency,
  appraisalMethod,
  setAppraisalMethod,
  appraisalMethods,
}: BatchProcessorProps) {
  const BATCH_ALLOWED_IDS = new Set([
    "claude-opus",
    "gemini-3.1-pro",
    "gemini-3stage",
    "claude-3stage",
    "claude-4stage",
  ]);
  const batchAppraisalMethods = appraisalMethods.filter(m => BATCH_ALLOWED_IDS.has(m.id));

  // Keep latest itemDatabase in a ref to avoid stale closures in long-running async loops
  const itemDatabaseRef = useRef(itemDatabase);
  itemDatabaseRef.current = itemDatabase;

  // Input sources
  const [batchFiles, setBatchFiles] = useState<BatchFile[]>([]);
  const [isProcessing, setIsProcessing] = useState(false);
  const [currentFileIndex, setCurrentFileIndex] = useState<number>(-1);
  const [currentArtworks, setCurrentArtworks] = useState<ProcessedArtwork[]>([]);
  const currentArtworksRef = useRef<ProcessedArtwork[]>([]);

  const updateCurrentArtworks = (artworks: ProcessedArtwork[]) => {
    currentArtworksRef.current = artworks;
    setCurrentArtworks(artworks);
  };
  const [logs, setLogs] = useState<string[]>([]);
  const [selectedFolderName, setSelectedFolderName] = useState<string>("");
  const [selectedFileIds, setSelectedFileIds] = useState<string[]>([]);
  const [filterDate, setFilterDate] = useState<string>("");
  const [filterStatus, setFilterStatus] = useState<string>("all");

  const currentFriendlyMethod = useMemo(() => {
    const selectedMethodConfig = appraisalMethods.find(m => m.id === appraisalMethod);
    return selectedMethodConfig ? selectedMethodConfig.name : appraisalMethod;
  }, [appraisalMethod, appraisalMethods]);

  const createBatchFileForHistoricalRow = (rowName: string, rowThumbnail: string, rowTimestamp: string): BatchFile => {
    const selectedMethodConfig = appraisalMethods.find(m => m.id === appraisalMethod);
    const friendlyMethod = selectedMethodConfig ? selectedMethodConfig.name : appraisalMethod;

    const originalItemsForGroup = itemDatabaseRef.current.filter(
      item => extractOriginalFilename(item.imageFileName).toLowerCase() === rowName.toLowerCase()
    );

    // De-duplicate by imageFileName so each unique crop appears only once,
    // regardless of how many methods have been applied to the same image.
    const seenFileNames = new Set<string>();
    const uniqueItems = originalItemsForGroup.filter(item => {
      if (seenFileNames.has(item.imageFileName)) return false;
      seenFileNames.add(item.imageFileName);
      return true;
    });

    return {
      id: crypto.randomUUID(),
      name: rowName,
      sourceType: "upload",
      status: "pending",
      thumbnailUrl: rowThumbnail,
      timestamp: rowTimestamp,
      methodUsed: friendlyMethod,
      artworks: uniqueItems.map(item => {
        const artworkIdx = item.imageFileName.indexOf("_Artwork_");
        const primaryIdx = item.imageFileName.indexOf("_Primary_Artwork");
        let label = "Primary Artwork";
        if (artworkIdx !== -1) {
          label = item.imageFileName.substring(artworkIdx + 9).replace(".jpg", "").replace(/_/g, " ");
        } else if (primaryIdx !== -1) {
          label = "Primary Artwork";
        }
        return {
          label,
          imagePreview: item.imageUrl,
          status: "pending"
        };
      })
    };
  };

  const batchFilesRef = useRef(batchFiles);
  batchFilesRef.current = batchFiles;
  
  const fileInputRef = useRef<HTMLInputElement>(null);
  const processingRef = useRef(false);

  const addLog = (message: string) => {
    setLogs((prev) => [`[${new Date().toLocaleTimeString()}] ${message}`, ...prev]);
  };

  // 2. Scan Browser Selected Directory (Client-side)
  const handleBrowserFolderUpload = (e: React.ChangeEvent<HTMLInputElement>) => {
    const files = e.target.files;
    if (!files || files.length === 0) return;

    const list = Array.from(files) as File[];
    const imageList = list.filter((file) => {
      return file.type.startsWith("image/");
    });

    if (imageList.length > 0) {
      const firstFile = imageList[0];
      if (firstFile && firstFile.webkitRelativePath) {
        const pathParts = firstFile.webkitRelativePath.split("/");
        if (pathParts.length > 1) {
          setSelectedFolderName(pathParts[0]);
        }
      }
      const newFiles = imageList.map((file) => {
        const isAlreadyAppraised = itemDatabaseRef.current.some(
          (item) => {
            const dbName = item.imageFileName.toLowerCase();
            const currName = file.name.toLowerCase();
            const matchesFile = dbName === currName || dbName.startsWith(currName + "_");
            if (!matchesFile) return false;

            const itemMethod = resolveMethodLabel(
              item.report.promptVersion || "standard",
              item.report.modelUsed || ""
            );

            return itemMethod === currentFriendlyMethod;
          }
        );
        return {
          id: crypto.randomUUID(),
          name: file.name,
          sourceType: "upload" as const,
          fileObject: file,
          status: (isAlreadyAppraised ? "already_appraised" : "pending") as BatchFile["status"],
          thumbnailUrl: URL.createObjectURL(file),
          timestamp: new Date().toLocaleDateString("en-US", {
            month: "short",
            day: "numeric",
            year: "numeric",
            hour: "2-digit",
            minute: "2-digit",
          }),
          methodUsed: currentFriendlyMethod
        };
      });
      setBatchFiles((prev) => [...prev, ...newFiles]);
      // Auto-select newly added files that are pending
      const newPendingIds = newFiles.filter(f => f.status === "pending").map(f => f.id);
      setSelectedFileIds((prev) => [...prev, ...newPendingIds]);
      const alreadyAppraisedCount = newFiles.filter(f => f.status === "already_appraised").length;
      addLog(`Selected browser directory. Found ${imageList.length} images. (${alreadyAppraisedCount} already appraised)`);
    } else {
      addLog("No valid image files found in browser selected folder.");
    }
    if (fileInputRef.current) fileInputRef.current.value = "";
  };

  const clearBatch = () => {
    setBatchFiles([]);
    setIsProcessing(false);
    setCurrentFileIndex(-1);
    updateCurrentArtworks([]);
    setLogs([]);
    setSelectedFolderName("");
    setSelectedFileIds([]);
    addLog("Batch queue cleared.");
  };

  // Helper: File Base64 encoder (Client-side)
  const fileToBase64 = (file: File): Promise<string> => {
    return new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.readAsDataURL(file);
      reader.onload = () => {
        if (typeof reader.result === "string") {
          resolve(reader.result);
        } else {
          reject(new Error("Failed to process image data"));
        }
      };
      reader.onerror = (error) => reject(error);
    });
  };

  // Dynamic Crop Helper (via HTML5 Canvas)

  // Core Processing Orchestrator
  const startProcessing = async () => {
    if (processingRef.current) return;
    if (batchFiles.length === 0) return;

    processingRef.current = true;
    setIsProcessing(true);

    try {
      const selectedMethodConfig = appraisalMethods.find(m => m.id === appraisalMethod);

      // Reset status/artworks to pending for selected files that don't match the current friendly method, or are already completed/failed
      let filesToUpdate = false;
      const updatedFiles = batchFiles.map(file => {
        if (selectedFileIds.includes(file.id)) {
          if (file.methodUsed !== currentFriendlyMethod || (file.status !== "completed" && file.status !== "already_appraised")) {
            filesToUpdate = true;
            return {
              ...file,
              status: "pending" as const,
              methodUsed: currentFriendlyMethod,
              error: undefined,
              artworks: file.artworks ? file.artworks.map(art => ({
                ...art,
                status: "pending" as const,
                error: undefined,
                report: undefined
              })) : undefined
            };
          }
        }
        return file;
      });

      let targetBatchFiles = batchFiles;
      if (filesToUpdate) {
        setBatchFiles(updatedFiles);
        targetBatchFiles = updatedFiles;
        // Wait for state to apply
        await new Promise(resolve => setTimeout(resolve, 0));
      }

      // Filter to selected files that are pending
      const selectedFiles = targetBatchFiles.filter(
        (f) => selectedFileIds.includes(f.id) && f.status === "pending"
      );

      if (selectedFiles.length === 0) {
        addLog("No pending files selected for appraisal.");
        processingRef.current = false;
        setIsProcessing(false);
        return;
      }

      addLog(`Batch processing queue initialized for ${selectedFiles.length} selected files.`);

      let targetHistory = [...itemDatabaseRef.current];

      // Loop sequentially over selected files
      for (let i = 0; i < selectedFiles.length; i++) {
        const targetFile = selectedFiles[i];
        const file = batchFilesRef.current.find(f => f.id === targetFile.id) || targetFile;

        const isProcessable = file.status === "pending" || file.status === "failed" || file.status === "detecting" || file.status === "splitting" || file.status === "appraising";

        if (!isProcessable) {
          continue;
        }

        if (file.status === "completed" || file.status === "already_appraised") {
          if (file.status === "already_appraised") {
            addLog(`Skipping already appraised file: ${file.name}`);
          }
          continue;
        }

      // Dynamic check against the latest updated database history
      const dynamicallyAlreadyAppraised = targetHistory.some(
        (item) => {
          const dbName = item.imageFileName.toLowerCase();
          const currName = file.name.toLowerCase();
          const matchesFile = dbName === currName || dbName.startsWith(currName + "_");
          if (!matchesFile) return false;

          const itemMethod = resolveMethodLabel(
            item.report.promptVersion || "standard",
            item.report.modelUsed || ""
          );

          return itemMethod === currentFriendlyMethod;
        }
      );

      if (dynamicallyAlreadyAppraised) {
        updateFileStatus(file.id, "already_appraised");
        addLog(`Skipping dynamically identified duplicate appraised file: ${file.name}`);
        continue;
      }

      setCurrentFileIndex(i);
      updateFileStatus(file.id, "detecting");
      addLog(`Processing file [${i + 1}/${batchFilesRef.current.length}]: ${file.name}`);

      try {
        let splitArtworks: ProcessedArtwork[] = [];
        
        // Define shared Lot identifiers for grouping
        const randomCode = Math.random().toString(36).substring(2, 6).toUpperCase();
        const cleanName = file.name.substring(0, 8).replace(/[^a-zA-Z0-9]/g, "");
        const sharedLotNumber = file.lotNumber || `Lot B-${cleanName}-${randomCode}`;
        const sharedLotTitle = file.lotTitle || `Split Group Lot: ${file.name}`;

        if (file.artworks && file.artworks.length > 0 && !file.fileObject && !file.localPath) {
          // Historical item re-appraisal - bypass detection/splitting and use existing artworks
          addLog(`Using existing ${file.artworks.length} cropped artwork(s) from historical record for re-appraisal.`);
          splitArtworks = file.artworks.map(art => ({
            ...art,
            status: "pending"
          }));
        } else {
          // Step A: Retrieve Base64 data of image
          let imageBase64 = "";
          let mimeType = "image/jpeg";

          if (file.sourceType === "upload" && file.fileObject) {
            imageBase64 = await fileToBase64(file.fileObject);
            mimeType = file.fileObject.type;
          } else if (file.sourceType === "local" && file.localPath) {
            addLog("Retrieving file payload from server...");
            const res = await fetch("/api/get-local-file", {
              method: "POST",
              headers: { "Content-Type": "application/json" },
              body: JSON.stringify({ filePath: file.localPath })
            });
            if (!res.ok) throw new Error(`Failed to load server file: ${res.status}`);
            const fileData = await res.json();
            imageBase64 = fileData.base64;
            mimeType = fileData.mimeType;
          } else {
            throw new Error("Missing source file content references.");
          }

          // Step B: Ask Gemini to detect multiple artworks (Collage Check)
          addLog("Detecting print bounds and checking for multi-artwork collages...");
          const detectRes = await fetch("/api/detect-artworks", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ imageBase64, mimeType })
          });
          if (!detectRes.ok) {
            const errData = await detectRes.json().catch(() => ({}));
            throw new Error(errData.error || `Collage detection returned error status ${detectRes.status}`);
          }
          const detection = await detectRes.json();

          if (detection.containsMultipleArtworks && detection.artworks.length > 1) {
            // Multiple pieces detected! Slicing...
            updateFileStatus(file.id, "splitting");
            addLog(`✂️ Collage Detected! Splitting scan sheet into ${detection.artworks.length} distinct print cropped scans.`);

            for (let j = 0; j < detection.artworks.length; j++) {
              const art = detection.artworks[j];
              try {
                addLog(`Slicing cropped artwork bounds for: ${art.label}...`);
                const croppedBase64 = await cropImageCanvas(imageBase64, art.box_2d);
                splitArtworks.push({
                  label: art.label,
                  imagePreview: croppedBase64,
                  status: "pending"
                });
              } catch (cropErr: any) {
                addLog(`Failed to slice crop bounds for ${art.label}: ${cropErr.message}`);
              }
            }
          } else {
            // Single piece detected. Proceed with original image bounds.
            splitArtworks.push({
              label: "Primary Artwork",
              imagePreview: imageBase64,
              status: "pending"
            });
          }
        }

        updateCurrentArtworks(splitArtworks);
        setBatchFiles((prev) => prev.map((f) => f.id === file.id ? { 
          ...f, 
          splitItemsCount: splitArtworks.length,
          lotNumber: splitArtworks.length > 1 ? sharedLotNumber : undefined,
          lotTitle: splitArtworks.length > 1 ? sharedLotTitle : undefined,
          artworks: splitArtworks,
        } : f));

        // Step C: Iterate and Appraise each split artwork
        updateFileStatus(file.id, "appraising");
        const appHistoryItems: AnalysisHistoryItem[] = [];

        for (let j = 0; j < splitArtworks.length; j++) {
          const art = splitArtworks[j];
          addLog(`Appraising print [${j + 1}/${splitArtworks.length}]: "${art.label}"...`);
          
          // Update current split artworks UI display
          updateArtStatusForFile(file.id, j, "appraising");

          try {
            const selectedMethodConfig = appraisalMethods.find(m => m.id === appraisalMethod);
            const targetQuality = selectedMethodConfig?.imageQuality || "original";
            const processedBase64 = await resizeImageIfNeeded(art.imagePreview, targetQuality);

            const analyzeRes = await fetch("/api/analyze-print", {
              method: "POST",
              headers: { "Content-Type": "application/json" },
              body: JSON.stringify({
                imageBase64: processedBase64,
                mimeType: "image/jpeg",
                currency,
                method: appraisalMethod
              }),
            });

            if (!analyzeRes.ok) {
              const errData = await analyzeRes.json().catch(() => ({}));
              throw new Error(errData.error || "Detailed print appraisal analysis failed.");
            }
            const report: PrintAnalysisReport = await analyzeRes.json();

            // Success, save report locally
            splitArtworks[j].report = report;
            splitArtworks[j].status = "completed";
            updateArtStatusForFile(file.id, j, "completed", report);

            // Create catalog record
            const historyItem: AnalysisHistoryItem = {
              id: crypto.randomUUID(),
              timestamp: new Date().toLocaleDateString("en-US", {
                month: "short",
                day: "numeric",
                year: "numeric",
                hour: "2-digit",
                minute: "2-digit",
              }),
              imageUrl: art.imagePreview, // cropped print photo
              imageFileName: `${file.name}_${art.label.replace(/\s+/g, "_")}.jpg`,
              imageSize: "Split Scan Crop",
              report,
              // Group together into a single lot if split from same collage scan
              lotNumber: splitArtworks.length > 1 ? sharedLotNumber : undefined,
              lotTitle: splitArtworks.length > 1 ? sharedLotTitle : undefined
            };
            appHistoryItems.push(historyItem);
            addLog(`✓ Appraised "${report.artworkTitle}" by ${report.likelyArtist}. Value: ${report.auctionEstimate.formattedEstimate}`);
          } catch (appErr: any) {
            console.error(appErr);
            splitArtworks[j].status = "failed";
            splitArtworks[j].error = appErr.message;
            updateArtStatusForFile(file.id, j, "failed", undefined, appErr.message);
            addLog(`Error appraising artwork bounds "${art.label}": ${appErr.message}`);
          }
        }

        // Add successful appraisals to history database
        if (appHistoryItems.length > 0) {
          const newHistory = [...appHistoryItems, ...targetHistory];
          targetHistory = await updateHistory(newHistory);
        }

        // Evaluate overall file success
        const allSucceeded = splitArtworks.every(art => art.status === "completed");
        updateFileStatus(file.id, allSucceeded ? "completed" : "failed", allSucceeded ? undefined : "Some split artworks failed appraisal.");
        addLog(`File analysis completed. Successfully catalogued ${appHistoryItems.length} records.`);

      } catch (err: any) {
        console.error(err);
        updateFileStatus(file.id, "failed", err.message);
        addLog(`❌ Failed to process file ${file.name}: ${err.message}`);
      }
    }

    // --- RETRY CYCLE FOR MODEL UNAVAILABILITY ---
    let unavailableFiles = batchFilesRef.current.filter(file => {
      if (!selectedFileIds.includes(file.id)) return false;
      if (file.status !== "failed") return false;
      if (file.error && isModelUnavailableError(file.error)) return true;
      if (file.artworks && file.artworks.some(art => art.status === "failed" && art.error && isModelUnavailableError(art.error))) {
        return true;
      }
      return false;
    });

    if (unavailableFiles.length > 0) {
      addLog(`⚠️ Found ${unavailableFiles.length} file(s) that failed due to model unavailability. Initiating rate-limit cooling retry cycle...`);
      
      for (let pass = 1; pass <= 2; pass++) {
        // Wait for rate limit cooling
        addLog(`[Retry Pass ${pass}/2] Waiting 6 seconds for rate limits / model availability to clear...`);
        await new Promise((resolve) => setTimeout(resolve, 6000));
        
        // Re-read latest state of unavailable files
        unavailableFiles = batchFilesRef.current.filter(file => {
          if (!selectedFileIds.includes(file.id)) return false;
          if (file.status !== "failed") return false;
          if (file.error && isModelUnavailableError(file.error)) return true;
          if (file.artworks && file.artworks.some(art => art.status === "failed" && art.error && isModelUnavailableError(art.error))) {
            return true;
          }
          return false;
        });

        if (unavailableFiles.length === 0) {
          addLog("All model-unavailable failures have been resolved successfully.");
          break;
        }

        addLog(`Retrying ${unavailableFiles.length} failed file(s) that match model unavailability...`);
        
        for (let i = 0; i < unavailableFiles.length; i++) {
          const file = unavailableFiles[i];
          addLog(`Retrying file: ${file.name}`);
          
          try {
            let imageBase64 = "";
            let mimeType = "image/jpeg";
            
            if (file.sourceType === "upload" && file.fileObject) {
              imageBase64 = await fileToBase64(file.fileObject);
              mimeType = file.fileObject.type;
            } else if (file.sourceType === "local" && file.localPath) {
              const res = await fetch("/api/get-local-file", {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({ filePath: file.localPath })
              });
              if (!res.ok) throw new Error(`Failed to load server file: ${res.status}`);
              const fileData = await res.json();
              imageBase64 = fileData.base64;
              mimeType = fileData.mimeType;
            }

            // Case A: Failed at detection level
            if (!file.artworks || file.artworks.length === 0 || (file.error && isModelUnavailableError(file.error))) {
              setCurrentFileIndex(batchFilesRef.current.findIndex(f => f.id === file.id));
              updateFileStatus(file.id, "detecting");
              
              const detectRes = await fetch("/api/detect-artworks", {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({ imageBase64, mimeType })
              });
              if (!detectRes.ok) {
                const errData = await detectRes.json().catch(() => ({}));
                throw new Error(errData.error || `Collage detection returned error status ${detectRes.status}`);
              }
              const detection = await detectRes.json();
              
              let splitArtworks: ProcessedArtwork[] = [];
              const randomCode = Math.random().toString(36).substring(2, 6).toUpperCase();
              const cleanName = file.name.substring(0, 8).replace(/[^a-zA-Z0-9]/g, "");
              const sharedLotNumber = `Lot B-${cleanName}-${randomCode}`;
              const sharedLotTitle = `Split Group Lot: ${file.name}`;
              
              if (detection.containsMultipleArtworks && detection.artworks.length > 1) {
                updateFileStatus(file.id, "splitting");
                for (let j = 0; j < detection.artworks.length; j++) {
                  const art = detection.artworks[j];
                  const croppedBase64 = await cropImageCanvas(imageBase64, art.box_2d);
                  splitArtworks.push({
                    label: art.label,
                    imagePreview: croppedBase64,
                    status: "pending"
                  });
                }
              } else {
                splitArtworks.push({
                  label: "Primary Artwork",
                  imagePreview: imageBase64,
                  status: "pending"
                });
              }

              updateCurrentArtworks(splitArtworks);
              setBatchFiles((prev) => prev.map((f) => f.id === file.id ? { 
                ...f, 
                splitItemsCount: splitArtworks.length,
                lotNumber: splitArtworks.length > 1 ? sharedLotNumber : undefined,
                lotTitle: splitArtworks.length > 1 ? sharedLotTitle : undefined,
                artworks: splitArtworks,
                error: undefined
              } : f));
              
              await new Promise((resolve) => setTimeout(resolve, 150));
            }

            // Case B: Process any pending/failed artworks
            const updatedFile = batchFilesRef.current.find(f => f.id === file.id)!;
            const artworksToProcess = updatedFile.artworks || [];
            updateCurrentArtworks(artworksToProcess);
            
            updateFileStatus(updatedFile.id, "appraising");
            const appHistoryItems: AnalysisHistoryItem[] = [];
            const sharedLotNumber = updatedFile.lotNumber;
            const sharedLotTitle = updatedFile.lotTitle;

            for (let j = 0; j < artworksToProcess.length; j++) {
              const art = artworksToProcess[j];
              if (art.status === "completed") continue;
              
              addLog(`Retrying appraisal of print [${j + 1}/${artworksToProcess.length}]: "${art.label}"...`);
              updateArtStatusForFile(updatedFile.id, j, "appraising");

              const selectedMethodConfig = appraisalMethods.find(m => m.id === appraisalMethod);
              const targetQuality = selectedMethodConfig?.imageQuality || "original";
              const processedBase64 = await resizeImageIfNeeded(art.imagePreview, targetQuality);

              try {
                const analyzeRes = await fetch("/api/analyze-print", {
                  method: "POST",
                  headers: { "Content-Type": "application/json" },
                  body: JSON.stringify({
                    imageBase64: processedBase64,
                    mimeType: "image/jpeg",
                    currency,
                    method: appraisalMethod
                  }),
                });

                if (!analyzeRes.ok) {
                  const errData = await analyzeRes.json().catch(() => ({}));
                  throw new Error(errData.error || "Detailed print appraisal analysis failed.");
                }
                const report: PrintAnalysisReport = await analyzeRes.json();

                updateArtStatusForFile(updatedFile.id, j, "completed", report);

                const historyItem: AnalysisHistoryItem = {
                  id: crypto.randomUUID(),
                  timestamp: new Date().toLocaleDateString("en-US", {
                    month: "short",
                    day: "numeric",
                    year: "numeric",
                    hour: "2-digit",
                    minute: "2-digit",
                  }),
                  imageUrl: art.imagePreview,
                  imageFileName: `${updatedFile.name}_${art.label.replace(/\s+/g, "_")}.jpg`,
                  imageSize: "Split Scan Crop",
                  report,
                  lotNumber: artworksToProcess.length > 1 ? sharedLotNumber : undefined,
                  lotTitle: artworksToProcess.length > 1 ? sharedLotTitle : undefined
                };
                appHistoryItems.push(historyItem);
                addLog(`✓ Appraised "${report.artworkTitle}" by ${report.likelyArtist}. Value: ${report.auctionEstimate.formattedEstimate}`);
              } catch (appErr: any) {
                updateArtStatusForFile(updatedFile.id, j, "failed", undefined, appErr.message);
                addLog(`Error appraising artwork bounds "${art.label}": ${appErr.message}`);
              }
            }

            if (appHistoryItems.length > 0) {
              const newHistory = [...appHistoryItems, ...targetHistory];
              targetHistory = await updateHistory(newHistory);
            }

            await new Promise((resolve) => setTimeout(resolve, 150));
            const finalFileState = batchFilesRef.current.find(f => f.id === file.id)!;
            const allSucceeded = finalFileState.artworks?.every(art => art.status === "completed") ?? false;
            updateFileStatus(finalFileState.id, allSucceeded ? "completed" : "failed", allSucceeded ? undefined : "Some split artworks failed appraisal.");
            
          } catch (err: any) {
            updateFileStatus(file.id, "failed", err.message);
            addLog(`❌ Failed to retry file ${file.name}: ${err.message}`);
          }
        }
      }
    }
    } catch (globalErr: any) {
      console.error("Global batch execution error:", globalErr);
      addLog(`❌ Global batch appraisal error: ${globalErr.message}`);
    } finally {
      processingRef.current = false;
      setIsProcessing(false);
      setSelectedFileIds(prev => prev.filter(id => {
        const file = batchFilesRef.current.find(f => f.id === id);
        return file ? file.status !== "completed" : true;
      }));
      addLog("Batch processing queue finished.");
    }
  };

  const updateFileStatus = (
    id: string, 
    status: BatchFile["status"], 
    error?: string
  ) => {
    setBatchFiles((prev) =>
      prev.map((f) => (f.id === id ? { ...f, status, error } : f))
    );
  };

  const updateArtStatusForFile = (
    fileId: string,
    index: number, 
    status: ProcessedArtwork["status"], 
    report?: PrintAnalysisReport,
    error?: string
  ) => {
    const updated = currentArtworksRef.current.map((a, idx) => (idx === index ? { ...a, status, report, error } : a));
    currentArtworksRef.current = updated;
    setCurrentArtworks(updated);

    setBatchFiles((prev) =>
      prev.map((f) =>
        f.id === fileId
          ? {
              ...f,
              artworks: f.artworks
                ? f.artworks.map((a, idx) =>
                    idx === index ? { ...a, status, report, error } : a
                  )
                : undefined,
            }
          : f
      )
    );
  };



  // Merge historical items and batchFiles into a unified list, grouped by original filename
  const unifiedRegistry = useMemo(() => {
    const groups: Record<string, {
      id: string;
      name: string;
      thumbnailUrl: string;
      timestamp: string;
      methods: Set<string>;
      statuses: Set<string>;
      errors: string[];
      isHistorical: boolean;
      originalItems: AnalysisHistoryItem[];
      batchFiles: BatchFile[];
    }> = {};

    // 1. Group historical items
    itemDatabase.forEach((item) => {
      const origName = extractOriginalFilename(item.imageFileName);
      const key = origName.toLowerCase();
      
      const promptVersion = item.report?.promptVersion || "standard";
      const modelUsed = item.report?.modelUsed || "gemini-2.5-flash";
      
      let methodStr = `${promptVersion.charAt(0).toUpperCase() + promptVersion.slice(1)} - ${modelUsed}`;
      if (promptVersion === "3stage" || modelUsed.includes("3-Stage")) {
        const config = appraisalMethods.find(m => {
          if (modelUsed.toLowerCase().includes("claude") || modelUsed.toLowerCase().includes("anthropic")) {
            return m.id === "claude-3stage";
          }
          return m.id === "gemini-3stage";
        });
        if (config) methodStr = config.name;
      } else {
        const config = appraisalMethods.find(m => m.promptKey === promptVersion && m.modelName === modelUsed);
        if (config) methodStr = config.name;
      }

      if (!groups[key]) {
        groups[key] = {
          id: item.id,
          name: origName,
          thumbnailUrl: item.imageUrl,
          timestamp: item.timestamp,
          methods: new Set([methodStr]),
          statuses: new Set(["appraised"]),
          errors: [],
          isHistorical: true,
          originalItems: [item],
          batchFiles: [],
        };
      } else {
        groups[key].methods.add(methodStr);
        groups[key].originalItems.push(item);
        try {
          if (new Date(item.timestamp) > new Date(groups[key].timestamp)) {
            groups[key].timestamp = item.timestamp;
          }
        } catch {
          // ignore
        }
      }
    });

    // 2. Group batchFiles
    batchFiles.forEach((file) => {
      const key = file.name.toLowerCase();

      let displayStatus: "new" | "failed" | "processing" | "appraised" = "new";
      if (file.status === "completed" || file.status === "already_appraised") {
        displayStatus = "appraised";
      } else if (file.status === "failed") {
        displayStatus = "failed";
      } else if (file.status === "detecting" || file.status === "splitting" || file.status === "appraising") {
        displayStatus = "processing";
      }

      if (!groups[key]) {
        groups[key] = {
          id: file.id,
          name: file.name,
          thumbnailUrl: file.thumbnailUrl || "",
          timestamp: file.timestamp || new Date().toLocaleDateString("en-US", {
            month: "short",
            day: "numeric",
            year: "numeric",
            hour: "2-digit",
            minute: "2-digit",
          }),
          methods: new Set(file.methodUsed ? [file.methodUsed] : []),
          statuses: new Set([displayStatus]),
          errors: file.error ? [file.error] : [],
          isHistorical: false,
          originalItems: [],
          batchFiles: [file],
        };
      } else {
        if (file.methodUsed) {
          groups[key].methods.add(file.methodUsed);
        }
        groups[key].statuses.add(displayStatus);
        if (file.error) {
          groups[key].errors.push(file.error);
        }
        groups[key].batchFiles.push(file);
        
        if (displayStatus !== "appraised") {
          groups[key].isHistorical = false;
        }
        if (!groups[key].thumbnailUrl && file.thumbnailUrl) {
          groups[key].thumbnailUrl = file.thumbnailUrl;
        }
      }
    });

    // Convert to row objects
    return Object.values(groups).map((g) => {
      const methodMap: Record<string, { status: "new" | "failed" | "processing" | "appraised"; error?: string }> = {};

      // 1. First, populate from original (appraised) items in database
      g.originalItems.forEach(item => {
        const promptVersion = item.report?.promptVersion || "standard";
        const modelUsed = item.report?.modelUsed || "gemini-2.5-flash";
        
        let methodStr = `${promptVersion.charAt(0).toUpperCase() + promptVersion.slice(1)} - ${modelUsed}`;
        if (promptVersion === "3stage" || modelUsed.includes("3-Stage")) {
          const config = appraisalMethods.find(m => {
            if (modelUsed.toLowerCase().includes("claude") || modelUsed.toLowerCase().includes("anthropic")) {
              return m.id === "claude-3stage";
            }
            return m.id === "gemini-3stage";
          });
          if (config) methodStr = config.name;
        } else {
          const config = appraisalMethods.find(m => m.promptKey === promptVersion && m.modelName === modelUsed);
          if (config) methodStr = config.name;
        }
        methodMap[methodStr] = { status: "appraised" };
      });

      // 2. Next, overlay active batchFiles in memory
      g.batchFiles.forEach(file => {
        if (file.methodUsed) {
          let displayStatus: "new" | "failed" | "processing" | "appraised" = "new";
          if (file.status === "completed" || file.status === "already_appraised") {
            displayStatus = "appraised";
          } else if (file.status === "failed") {
            displayStatus = "failed";
          } else if (file.status === "detecting" || file.status === "splitting" || file.status === "appraising") {
            displayStatus = "processing";
          }
          
          if (methodMap[file.methodUsed] && methodMap[file.methodUsed].status === "appraised") {
            // Keep successfully appraised status
          } else {
            methodMap[file.methodUsed] = { 
              status: displayStatus, 
              error: file.error 
            };
          }
        }
      });

      if (Object.keys(methodMap).length === 0) {
        methodMap[currentFriendlyMethod] = { status: "new" };
      }

      const methodsWithStatus = Object.entries(methodMap).map(([method, details]) => ({
        method,
        status: details.status,
        error: details.error
      }));

      let finalStatus: "new" | "failed" | "processing" | "appraised" = "appraised";
      const statuses = new Set(methodsWithStatus.map(m => m.status));
      if (statuses.has("processing")) {
        finalStatus = "processing";
      } else if (statuses.has("new")) {
        finalStatus = "new";
      } else if (statuses.has("failed")) {
        finalStatus = "failed";
      }

      return {
        id: g.id,
        name: g.name,
        thumbnailUrl: g.thumbnailUrl,
        timestamp: g.timestamp,
        methodUsed: methodsWithStatus.map(m => m.method).join(", "),
        methodsList: methodsWithStatus.map(m => m.method),
        methodsWithStatus,
        status: finalStatus,
        isHistorical: g.isHistorical && !g.batchFiles.some(f => f.status !== "completed" && f.status !== "already_appraised"),
        error: g.errors.join("; "),
        originalFileIds: g.batchFiles.map(f => f.id),
      };
    });
  }, [itemDatabase, batchFiles, currentFriendlyMethod]);

  const filteredRegistry = useMemo(() => {
    return unifiedRegistry.filter((row) => {
      // 1. Status Filter
      if (filterStatus !== "all") {
        if (filterStatus === "new" && row.status !== "new" && row.status !== "processing") {
          return false;
        }
        if (filterStatus === "appraised" && row.status !== "appraised") {
          return false;
        }
        if (filterStatus === "failed" && row.status !== "failed") {
          return false;
        }
      }

      // 2. Date Filter
      if (filterDate !== "") {
        try {
          const filterD = new Date(filterDate);
          const itemD = new Date(row.timestamp);
          const match =
            filterD.getFullYear() === itemD.getFullYear() &&
            filterD.getMonth() === itemD.getMonth() &&
            filterD.getDate() === itemD.getDate();
          if (!match) return false;
        } catch {
          // ignore
        }
      }

      return true;
    });
  }, [unifiedRegistry, filterStatus, filterDate]);

  const visibleSelectableRows = useMemo(() => {
    return filteredRegistry.filter(row => {
      const currentMethodDetail = row.methodsWithStatus.find(m => m.method === currentFriendlyMethod);
      const currentMethodStatus = currentMethodDetail ? currentMethodDetail.status : "new";
      return currentMethodStatus !== "appraised";
    });
  }, [filteredRegistry, currentFriendlyMethod]);

  const isAllVisibleSelected = useMemo(() => {
    return visibleSelectableRows.length > 0 && visibleSelectableRows.every(row => 
      row.originalFileIds.length > 0 && row.originalFileIds.every(id => selectedFileIds.includes(id))
    );
  }, [visibleSelectableRows, selectedFileIds]);

  const toggleSelectAll = () => {
    if (isAllVisibleSelected) {
      const idsToRemove = visibleSelectableRows.flatMap(r => r.originalFileIds);
      setSelectedFileIds(prev => prev.filter(id => !idsToRemove.includes(id)));
    } else {
      const newBatchFiles: BatchFile[] = [];
      const idsToAdd: string[] = [];

      visibleSelectableRows.forEach(row => {
        if (row.originalFileIds.length === 0) {
          const newFile = createBatchFileForHistoricalRow(row.name, row.thumbnailUrl, row.timestamp);
          newBatchFiles.push(newFile);
          idsToAdd.push(newFile.id);
        } else {
          row.originalFileIds.forEach(id => {
            idsToAdd.push(id);
          });
        }
      });

      if (newBatchFiles.length > 0) {
        setBatchFiles(prev => [...prev, ...newBatchFiles]);
      }

      setSelectedFileIds(prev => {
        const next = [...prev];
        idsToAdd.forEach(id => {
          if (!next.includes(id)) next.push(id);
        });
        return next;
      });
    }
  };

  return (
    <div className="space-y-8 animate-fadeIn text-rosebery-text-normal">
      {/* Introduction */}
      <div className="text-center space-y-2 max-w-2xl mx-auto">
        <h2 className="text-3xl font-serif font-semibold text-rosebery-charcoal tracking-wide">
          Automated Batch Appraisal
        </h2>
        <p className="text-xs md:text-sm text-rosebery-muted leading-relaxed">
          Upload entire folders of print sheets. The engine checks for print collages, automatically splits multi-artwork images using Gemini bounds, runs appraisals, and groups split-out items under unified auction lots.
        </p>
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-12 gap-8">
        {/* Left Console: Inputs & Queue */}
        <div className="lg:col-span-5 space-y-6">
          <div className="bg-white border border-rosebery-border rounded-xl p-6 shadow-gallery-soft space-y-6">
            <h3 className="text-base font-serif font-semibold text-rosebery-charcoal flex items-center gap-2 border-b border-rosebery-border pb-3">
              <FolderOpen className="w-5 h-5 text-rosebery-primary" />
              Batch Folder Sources
            </h3>

            {/* Appraisal Method Selection */}
            <div className="space-y-2 bg-stone-50 border border-rosebery-border p-4 rounded-lg">
              <label className="text-[10px] font-mono uppercase tracking-wider text-rosebery-primary font-bold block flex items-center justify-between">
                <span>Appraisal Method / LLM Model</span>
                <span className="text-[9px] text-rosebery-gold font-mono font-semibold tracking-wider uppercase">Config</span>
              </label>
              <select
                value={appraisalMethod}
                onChange={(e) => setAppraisalMethod(e.target.value)}
                className="w-full bg-white border border-rosebery-border focus:border-rosebery-primary focus:ring-1 focus:ring-rosebery-primary/20 rounded-sm p-2.5 text-xs text-rosebery-charcoal outline-hidden font-mono transition-all duration-200 cursor-pointer"
                disabled={isProcessing}
              >
                {batchAppraisalMethods.map((method) => {
                  return (
                    <option key={method.id} value={method.id}>
                      {method.name}
                    </option>
                  );
                })}
              </select>
              {(() => {
                const selectedMethod = batchAppraisalMethods.find(m => m.id === appraisalMethod);
                if (!selectedMethod) return null;
                return (
                  <div className="text-[10px] font-mono text-rosebery-muted leading-relaxed border-t border-rosebery-border/40 pt-2 space-y-1">
                    <p className="text-rosebery-charcoal font-semibold">{selectedMethod.description}</p>
                    <p className="text-[9px] flex gap-3 mt-1">
                      <span>Image Quality: <strong className="text-rosebery-primary uppercase">{selectedMethod.imageQuality}</strong></span>
                      <span>Aux Scans: <strong className="text-rosebery-primary uppercase">{selectedMethod.includeAuxiliaryScans ? "Yes" : "No"}</strong></span>
                    </p>
                  </div>
                );
              })()}
            </div>

            {/* Source Options Grid */}
            {/* Folder Directory Selector */}
            <div className="bg-stone-50 border border-rosebery-border p-6 rounded-lg flex flex-col items-center justify-center text-center space-y-4">
              <div className="space-y-1.5 max-w-md">
                <span className="text-[10px] font-mono text-rosebery-primary uppercase tracking-widest font-semibold block">
                  Folder Directory Selector
                </span>
                <p className="text-xs text-rosebery-muted">
                  Select a folder on your machine via the standard web directory selector. All image scans inside will be loaded and queued for collage detection and batch appraisal.
                </p>
              </div>
              <div className="w-full max-w-xs pt-1 flex flex-col items-center space-y-3">
                <input
                  ref={fileInputRef}
                  type="file"
                  webkitdirectory=""
                  directory=""
                  multiple
                  className="hidden"
                  onChange={handleBrowserFolderUpload}
                  disabled={isProcessing}
                />
                <button
                  type="button"
                  onClick={() => fileInputRef.current?.click()}
                  disabled={isProcessing}
                  className="w-full bg-white hover:bg-rosebery-cream-bg border border-rosebery-primary text-rosebery-primary font-mono text-xs tracking-wider uppercase py-3 rounded-xs font-bold flex items-center justify-center gap-2 cursor-pointer transition-colors duration-200"
                >
                  <FolderOpen className="w-4 h-4 text-rosebery-primary" />
                  Select Folder Directory
                </button>
                {selectedFolderName && (
                  <span className="text-[11px] font-mono text-rosebery-primary/80 bg-rosebery-cream-bg/35 border border-rosebery-border px-3 py-1.5 rounded-sm truncate max-w-full">
                    Location: <strong className="text-rosebery-charcoal">{selectedFolderName}/</strong>
                  </span>
                )}
              </div>
            </div>

            {/* Queue Controls */}
            {batchFiles.length > 0 && (
              <div className="flex justify-between items-center bg-rosebery-cream-bg border border-rosebery-border p-3.5 rounded-lg">
                <div className="text-xs text-rosebery-charcoal font-medium">
                  Selected: <span className="font-mono font-bold text-rosebery-primary">{batchFiles.filter(f => selectedFileIds.includes(f.id)).length} of {batchFiles.length} Scans</span>
                </div>
                <div className="flex items-center gap-2">
                  <button
                    type="button"
                    onClick={clearBatch}
                    disabled={isProcessing}
                    className="text-[10px] font-mono font-bold uppercase tracking-wider text-rosebery-muted hover:text-rosebery-primary px-3 py-1.5 cursor-pointer transition-colors"
                  >
                    Clear Queue
                  </button>
                  <button
                    type="button"
                    onClick={startProcessing}
                    disabled={isProcessing || batchFiles.filter(f => selectedFileIds.includes(f.id) && (f.status === "pending" || f.status === "failed")).length === 0}
                    className="bg-rosebery-primary hover:bg-rosebery-primary-hover disabled:bg-stone-300 text-white font-mono text-[10px] font-bold tracking-widest uppercase px-5 py-2 rounded-xs flex items-center gap-1.5 cursor-pointer transition-colors"
                  >
                    {isProcessing ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <Play className="w-3.5 h-3.5" />}
                    Appraise Selected
                  </button>
                </div>
              </div>
            )}
          </div>
        </div>

        {/* Right Console: Live Splitting & Real-time logs */}
        <div className="lg:col-span-7">
          {currentFileIndex >= 0 && currentArtworks.length > 0 ? (
            <div className="grid grid-cols-1 md:grid-cols-2 gap-6 items-start">
              {/* Active Split Preview */}
              <div className="bg-white border border-rosebery-border rounded-xl p-6 shadow-gallery-soft space-y-5 animate-fadeIn">
                <h3 className="text-base font-serif font-semibold text-rosebery-charcoal flex items-center gap-2 border-b border-rosebery-border pb-3">
                  <Scissors className="w-5 h-5 text-rosebery-primary" />
                  Collage Split Preview
                </h3>

                <div className="bg-rosebery-cream-bg/30 border border-rosebery-border p-3.5 rounded-lg space-y-1 text-xs">
                  <div className="flex justify-between font-mono text-[10px] text-rosebery-primary font-bold">
                    <span>SOURCE FILE:</span>
                    <span className="truncate max-w-[200px]">{batchFiles[currentFileIndex]?.name}</span>
                  </div>
                  {batchFiles[currentFileIndex]?.lotNumber && (
                    <div className="flex justify-between font-mono text-[10px] text-rosebery-muted pt-1">
                      <span>SHARED GROUP LOT:</span>
                      <span className="font-bold text-rosebery-charcoal">{batchFiles[currentFileIndex].lotNumber}</span>
                    </div>
                  )}
                </div>

                {/* Grid of cropped works */}
                <div className="grid grid-cols-2 gap-4">
                  {currentArtworks.map((art, idx) => (
                    <div key={idx} className="bg-stone-50 border border-rosebery-border p-3 rounded-lg flex flex-col space-y-2 shadow-xs relative overflow-hidden group">
                      <div className="relative aspect-square rounded-sm overflow-hidden bg-white border border-rosebery-border flex items-center justify-center">
                        <img src={art.imagePreview} alt={art.label} className="max-w-full max-h-full object-contain" />
                      </div>
                      
                      <div className="space-y-1 text-center">
                        <span className="text-[10px] font-mono text-rosebery-primary font-semibold block truncate">
                          {art.label}
                        </span>
                        
                        <span className={`text-[8.5px] font-mono uppercase tracking-wider font-bold px-1.5 py-0.5 rounded-full border inline-block ${
                          art.status === "appraising"
                            ? "bg-amber-50 border-amber-200 text-amber-800 animate-pulse"
                            : art.status === "completed"
                              ? "bg-emerald-50 border-emerald-200 text-emerald-800"
                              : art.status === "failed"
                                ? "bg-rose-50 border-rose-200 text-rose-800"
                                : "bg-white border-stone-200 text-stone-400"
                        }`}>
                          {art.status}
                        </span>
                      </div>

                      {art.report && (
                        <div className="absolute inset-0 bg-[#4C0B2A]/90 text-white p-3 flex flex-col justify-between opacity-0 group-hover:opacity-100 transition-opacity duration-300 rounded-lg">
                          <div className="space-y-1 text-[10px] leading-tight">
                            <p className="font-serif font-bold truncate">{art.report.artworkTitle}</p>
                            <p className="text-stone-300 font-sans truncate">{art.report.likelyArtist}</p>
                            <p className="text-stone-300 font-sans font-semibold pt-1">{art.report.creationPeriod}</p>
                          </div>
                          <div className="bg-white text-rosebery-primary rounded-xs py-1 text-center text-[9px] font-mono font-bold">
                            {art.report.auctionEstimate.formattedEstimate}
                          </div>
                        </div>
                      )}
                    </div>
                  ))}
                </div>
              </div>

              {/* Real-time Logger Console */}
              <div className="bg-rosebery-charcoal text-[#A8D39F] font-mono text-xs rounded-xl p-5 shadow-gallery-deep border border-stone-800 space-y-3.5 flex flex-col max-h-[380px]">
                <div className="flex justify-between items-center border-b border-stone-800 pb-2.5">
                  <span className="text-[10px] text-stone-400 uppercase tracking-widest font-bold font-sans">
                    BATCH CONSOLE LOGS
                  </span>
                  <div className="flex items-center gap-1.5">
                    <span className="w-2 h-2 rounded-full bg-emerald-500 animate-pulse"></span>
                    <span className="text-[9px] text-stone-400 font-sans uppercase">Online</span>
                  </div>
                </div>
                <div className="space-y-2 flex-1 min-h-[220px] overflow-y-auto flex flex-col-reverse text-[11px] leading-relaxed custom-scrollbar selection:bg-emerald-800 selection:text-white">
                  {logs.length === 0 ? (
                    <p className="text-stone-500 italic">No activity logged. Select folder source and start queue.</p>
                  ) : (
                    logs.map((log, idx) => (
                      <p 
                        key={idx} 
                        className={
                          log.includes("✓") || log.includes("Successfully")
                            ? "text-emerald-400" 
                            : log.includes("❌") || log.includes("Failed") || log.includes("Error")
                              ? "text-rose-400 font-semibold"
                              : log.includes("✂️")
                                ? "text-amber-400"
                                : "text-[#E3EAE0]"
                        }
                      >
                        {log}
                      </p>
                    ))
                  )}
                </div>
              </div>
            </div>
          ) : (
            /* Real-time Logger Console (full width when no active preview, max-height limited) */
            <div className="bg-rosebery-charcoal text-[#A8D39F] font-mono text-xs rounded-xl p-5 shadow-gallery-deep border border-stone-800 space-y-3.5 flex flex-col max-h-[280px]">
              <div className="flex justify-between items-center border-b border-stone-800 pb-2.5">
                <span className="text-[10px] text-stone-400 uppercase tracking-widest font-bold font-sans">
                  BATCH CONSOLE LOGS
                </span>
                <div className="flex items-center gap-1.5">
                  <span className="w-2 h-2 rounded-full bg-emerald-500 animate-pulse"></span>
                  <span className="text-[9px] text-stone-400 font-sans uppercase">Online</span>
                </div>
              </div>
              <div className="space-y-2 flex-1 min-h-[180px] overflow-y-auto flex flex-col-reverse text-[11px] leading-relaxed custom-scrollbar selection:bg-emerald-800 selection:text-white">
                {logs.length === 0 ? (
                  <p className="text-stone-500 italic">No activity logged. Select folder source and start queue.</p>
                ) : (
                  logs.map((log, idx) => (
                    <p 
                      key={idx} 
                      className={
                        log.includes("✓") || log.includes("Successfully")
                          ? "text-emerald-400" 
                          : log.includes("❌") || log.includes("Failed") || log.includes("Error")
                            ? "text-rose-400 font-semibold"
                            : log.includes("✂️")
                              ? "text-amber-400"
                              : "text-[#E3EAE0]"
                      }
                    >
                      {log}
                    </p>
                  ))
                )}
              </div>
            </div>
          )}
        </div>
      </div>

      {/* Appraisal & Upload Registry Card */}
      <div className="bg-white border border-rosebery-border rounded-xl p-6 shadow-gallery-soft space-y-6 animate-fadeIn">
        <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between border-b border-rosebery-border pb-4 gap-4">
          <div>
            <h3 className="text-lg font-serif font-semibold text-rosebery-charcoal flex items-center gap-2">
              <Database className="w-5 h-5 text-rosebery-primary" />
              Appraisal & Upload Registry
            </h3>
            <p className="text-xs text-rosebery-muted mt-1">
              Showing both saved historical appraised print records and active batch uploads.
            </p>
          </div>

          <div className="flex items-center gap-3">
            {selectedFileIds.length > 0 && (
              <button
                type="button"
                onClick={startProcessing}
                disabled={isProcessing || visibleSelectableRows.filter(row => row.originalFileIds.length > 0 && row.originalFileIds.every(id => selectedFileIds.includes(id))).length === 0}
                className="bg-rosebery-primary hover:bg-rosebery-primary-hover disabled:bg-stone-300 text-white font-mono text-xs font-bold tracking-widest uppercase px-5 py-2.5 rounded-sm flex items-center gap-1.5 cursor-pointer transition-colors shadow-xs"
              >
                {isProcessing ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <Play className="w-3.5 h-3.5" />}
                Appraise Selected ({visibleSelectableRows.filter(row => row.originalFileIds.length > 0 && row.originalFileIds.every(id => selectedFileIds.includes(id))).length})
              </button>
            )}
          </div>
        </div>

        {/* Filters Panel */}
        <div className="grid grid-cols-1 sm:grid-cols-3 gap-4 bg-stone-50 border border-rosebery-border/70 p-4 rounded-lg">
          {/* Status Filter */}
          <div className="space-y-1">
            <label className="text-[10px] font-mono text-rosebery-primary font-bold uppercase tracking-wider block">
              Filter by Status
            </label>
            <select
              value={filterStatus}
              onChange={(e) => setFilterStatus(e.target.value)}
              className="w-full bg-white border border-rosebery-border rounded-xs px-3 py-2 text-xs text-rosebery-charcoal outline-hidden focus:border-rosebery-primary transition-all duration-200 cursor-pointer font-sans"
            >
              <option value="all">Show All Statuses</option>
              <option value="new">New / Enqueued</option>
              <option value="appraised">Appraised / Saved</option>
              <option value="failed">Failed Appraisal</option>
            </select>
          </div>

          {/* Date Filter */}
          <div className="space-y-1">
            <label className="text-[10px] font-mono text-rosebery-primary font-bold uppercase tracking-wider block">
              Filter by Upload Date
            </label>
            <div className="flex gap-1.5 items-center">
              <input
                type="date"
                value={filterDate}
                onChange={(e) => setFilterDate(e.target.value)}
                className="w-full bg-white border border-rosebery-border rounded-xs px-3 py-2 text-xs text-rosebery-charcoal outline-hidden focus:border-rosebery-primary font-mono cursor-pointer"
              />
              {filterDate && (
                <button
                  type="button"
                  onClick={() => setFilterDate("")}
                  className="px-3 py-2 text-xs text-rosebery-muted hover:text-rosebery-primary font-mono font-bold bg-stone-100 hover:bg-stone-200/60 rounded-xs border border-rosebery-border cursor-pointer transition-colors"
                >
                  Clear
                </button>
              )}
            </div>
          </div>

          {/* Quick Metrics */}
          <div className="flex items-center justify-end px-4 text-xs font-mono text-rosebery-muted bg-stone-100/50 rounded-xs border border-dashed border-rosebery-border/60 p-3">
            <div className="space-y-1 text-right">
              <div>Total Registry Items: <strong className="text-rosebery-charcoal">{filteredRegistry.length}</strong></div>
              <div>Selected: <strong className="text-rosebery-primary">{selectedFileIds.length}</strong></div>
            </div>
          </div>
        </div>

        {/* Table container */}
        <div className="overflow-x-auto border border-rosebery-border rounded-lg">
          <table className="w-full text-left border-collapse">
            <thead>
              <tr className="bg-stone-50 border-b border-rosebery-border text-[10px] font-mono uppercase tracking-wider text-rosebery-primary font-bold">
                <th className="p-3.5 w-10 text-center">
                  <input
                    type="checkbox"
                    checked={isAllVisibleSelected}
                    ref={(el) => {
                      if (el) {
                        el.indeterminate = !isAllVisibleSelected && visibleSelectableRows.some(row => 
                          row.originalFileIds.some(id => selectedFileIds.includes(id))
                        );
                      }
                    }}
                    onChange={toggleSelectAll}
                    disabled={visibleSelectableRows.length === 0}
                    className="w-3.5 h-3.5 rounded-sm border-stone-300 text-rosebery-primary focus:ring-rosebery-primary/20 accent-rosebery-primary cursor-pointer"
                  />
                </th>
                <th className="p-3.5 w-16">Thumbnail</th>
                <th className="p-3.5">Filename</th>
                <th className="p-3.5">Upload Date & Time</th>
                <th className="p-3.5">Appraisal Method</th>
                <th className="p-3.5 w-28">Status</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-rosebery-border/40 text-xs">
              {filteredRegistry.length === 0 ? (
                <tr>
                  <td colSpan={6} className="p-8 text-center text-rosebery-muted italic bg-stone-50/20">
                    No matching registry records found.
                  </td>
                </tr>
              ) : (
                filteredRegistry.map((row) => {
                  const currentMethodDetail = row.methodsWithStatus.find(m => m.method === currentFriendlyMethod);
                  const currentMethodStatus = currentMethodDetail ? currentMethodDetail.status : "new";
                  const isSelectable = currentMethodStatus !== "appraised";
                  const isChecked = row.originalFileIds.length > 0 && row.originalFileIds.every(id => selectedFileIds.includes(id));
                  
                  return (
                    <tr 
                      key={row.id}
                      className={`hover:bg-rosebery-cream-bg/20 transition-colors duration-150 ${
                        row.status === "processing" ? "bg-amber-50/15" : ""
                      }`}
                    >
                      <td className="p-3.5 text-center">
                        <input
                          type="checkbox"
                          checked={isChecked}
                          disabled={!isSelectable || isProcessing}
                          onChange={() => {
                            if (isChecked) {
                              setSelectedFileIds(prev => prev.filter(id => !row.originalFileIds.includes(id)));
                            } else {
                              let fileIds = [...row.originalFileIds];
                              if (fileIds.length === 0) {
                                const newFile = createBatchFileForHistoricalRow(row.name, row.thumbnailUrl, row.timestamp);
                                setBatchFiles(prev => [...prev, newFile]);
                                fileIds = [newFile.id];
                              }
                              setSelectedFileIds(prev => {
                                const next = [...prev];
                                fileIds.forEach(id => {
                                  if (!next.includes(id)) next.push(id);
                                });
                                return next;
                              });
                            }
                          }}
                          className={`w-3.5 h-3.5 rounded-sm border-stone-300 focus:ring-rosebery-primary/20 accent-rosebery-primary ${
                            isSelectable ? "cursor-pointer text-rosebery-primary" : "cursor-not-allowed opacity-40"
                          }`}
                        />
                      </td>
                      <td className="p-3.5">
                        <div className="w-12 h-12 bg-white border border-rosebery-border rounded-sm flex items-center justify-center overflow-hidden shadow-xs">
                          {row.thumbnailUrl ? (
                            <img 
                              src={row.thumbnailUrl} 
                              alt="Scan Crop Preview" 
                              className="w-full h-full object-contain"
                              onError={(e) => {
                                (e.target as HTMLElement).style.display = 'none';
                              }}
                            />
                          ) : (
                            <span className="text-[10px] font-mono text-stone-300">No Image</span>
                          )}
                        </div>
                      </td>
                      <td className="p-3.5 font-medium text-rosebery-charcoal break-all max-w-[240px]">
                        {row.name}
                      </td>
                      <td className="p-3.5 font-mono text-[11px] text-rosebery-muted">
                        {row.timestamp}
                      </td>
                      <td className="p-3.5 font-mono text-[11px] text-rosebery-muted">
                        <div className="flex flex-col space-y-2">
                          {row.methodsWithStatus.map((m, idx) => (
                            <div key={idx} className="min-h-6 flex items-center">
                              {m.method}
                            </div>
                          ))}
                        </div>
                      </td>
                      <td className="p-3.5">
                        <div className="flex flex-col space-y-2">
                          {row.methodsWithStatus.map((m, idx) => (
                            <div key={idx} className="min-h-6 flex items-center">
                              <span 
                                title={m.status === "failed" ? m.error : undefined}
                                className={`text-[10px] font-mono font-bold uppercase tracking-wider px-2.5 py-0.5 rounded-full border inline-flex items-center gap-1.5 ${
                                  m.status === "appraised"
                                    ? "bg-emerald-50 border-emerald-200 text-emerald-800"
                                    : m.status === "failed"
                                      ? "bg-rose-50 border-rose-200 text-rose-800 cursor-help"
                                      : m.status === "processing"
                                        ? "bg-amber-50 border-amber-200 text-amber-800 animate-pulse"
                                        : "bg-blue-50 border-blue-200 text-blue-800" // new
                                }`}
                              >
                                {m.status === "processing" ? (
                                  <>
                                    <Loader2 className="w-3 h-3 animate-spin" />
                                    Appraising
                                  </>
                                ) : (
                                  <>
                                    {m.status}
                                    {m.status === "failed" && <AlertCircle className="w-3 h-3 text-rose-600" />}
                                  </>
                                )}
                              </span>
                            </div>
                          ))}
                        </div>
                      </td>
                    </tr>
                  );
                })
              )}
            </tbody>
          </table>
        </div>
      </div>
    </div>
  );
}
