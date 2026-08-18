import React, { useState, useEffect, useRef } from "react";
import { 
  History, 
  RotateCcw,
  Loader2,
  Compass,
  Sparkles,
  CheckCircle2,
  Info,
  X,
  Mail,
  Check,
  Layers,
  User,
  Settings,
  Award
} from "lucide-react";
import { PrintAnalysisReport, AnalysisHistoryItem, CatalogMetadata } from "./types";
import ReportView from "./components/ReportView";
import UploadPanel from "./components/UploadPanel";
import AppraiserNotesInput from "./components/AppraiserNotesInput";
import CatalogListView from "./components/CatalogListView";
import BatchProcessor from "./components/BatchProcessor";
import SettingsView from "./components/SettingsView";
import AdminPromptPanel from "./components/AdminPromptPanel";
import { 
  getHistoryDB, 
  setHistoryDB, 
  getCatalogsListDB, 
  setCatalogsListDB, 
  getActiveCatalogIdDB, 
  setActiveCatalogIdDB, 
  getCatalogItemsDB, 
  setCatalogItemsDB, 
  deleteCatalogItemsDB,
  getItemDatabaseDB,
  setItemDatabaseDB,
  migrateGuestToUserDB
} from "./utils/db";
import { resolveMethodLabel } from "./utils/resolveMethodLabel";
import { cropImageCanvas } from "./utils/cropImageCanvas";

// Helper: Generate a small compressed JPEG thumbnail image (max 300x300) for history items to prevent LocalStorage QuotaExceededError
const generateThumbnail = (fileOrBase64: File | string, maxWidth = 300, maxHeight = 300): Promise<string> => {
  return new Promise((resolve) => {
    const img = new Image();
    img.crossOrigin = "anonymous";
    img.onload = () => {
      let width = img.width;
      let height = img.height;
      
      if (width > height) {
        if (width > maxWidth) {
          height = Math.round((height * maxWidth) / width);
          width = maxWidth;
        }
      } else {
        if (height > maxHeight) {
          width = Math.round((width * maxHeight) / height);
          height = maxHeight;
        }
      }

      const canvas = document.createElement("canvas");
      canvas.width = width;
      canvas.height = height;

      const ctx = canvas.getContext("2d");
      if (ctx) {
        ctx.imageSmoothingEnabled = true;
        ctx.imageSmoothingQuality = "high";
        ctx.drawImage(img, 0, 0, width, height);
        resolve(canvas.toDataURL("image/jpeg", 0.75));
      } else {
        resolve(typeof fileOrBase64 === "string" ? fileOrBase64 : "");
      }
    };
    img.onerror = () => {
      resolve(typeof fileOrBase64 === "string" ? fileOrBase64 : "");
    };

    if (typeof fileOrBase64 === "string") {
      img.src = fileOrBase64;
    } else {
      const reader = new FileReader();
      reader.onload = (e) => {
        if (e.target?.result && typeof e.target.result === "string") {
          img.src = e.target.result;
        } else {
          resolve("");
        }
      };
      reader.onerror = () => resolve("");
      reader.readAsDataURL(fileOrBase64);
    }
  });
};

const generateUniqueCatalogId = (existingCatalogs: { id: string }[], username: string | null): string => {
  const userId = username ? username : "guest";
  let attempts = 0;
  while (attempts < 100) {
    const auctionId = Math.floor(1000 + Math.random() * 9000).toString();
    const id = `${userId}-${auctionId}`;
    if (!existingCatalogs.some(c => c.id === id)) {
      return id;
    }
    attempts++;
  }
  const auctionId = Math.floor(1000 + Math.random() * 9000).toString();
  return `${userId}-${auctionId}`;
};

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

export default function App() {
  // Navigation / Workspace States
  const [activeTab, setActiveTab] = useState<"sandbox" | "batch" | "history" | "settings" | "admin">("sandbox");
  const [dragActive, setDragActive] = useState(false);
  
  // Input states
  const [selectedFile, setSelectedFile] = useState<File | null>(null);
  const [previewUrl, setPreviewUrl] = useState<string | null>(null);
  
  // Auxiliary image states
  const [signatureFile, setSignatureFile] = useState<File | null>(null);
  const [signaturePreview, setSignaturePreview] = useState<string | null>(null);
  const [damageFile, setDamageFile] = useState<File | null>(null);
  const [damagePreview, setDamagePreview] = useState<string | null>(null);
  const [scaleFile, setScaleFile] = useState<File | null>(null);
  const [scalePreview, setScalePreview] = useState<string | null>(null);

  const [currency, setCurrency] = useState<"USD" | "GBP" | "EUR">("USD");
  const [appraisalMethods, setAppraisalMethods] = useState<any[]>([]);
  const [appraisalMethod, setAppraisalMethod] = useState<string>("claude-4stage-fast");
  const [userNotes, setUserNotes] = useState("");
  const [provenanceNotes, setProvenanceNotes] = useState("");
  const [conditionNotes, setConditionNotes] = useState("");
  const [literatureNotes, setLiteratureNotes] = useState("");
  
  // Progress/Loading States
  const [isLoading, setIsLoading] = useState(false);
  const [loadingStep, setLoadingStep] = useState("");
  const [loadingProgress, setLoadingProgress] = useState(0);
  const abortControllerRef = useRef<AbortController | null>(null);
  
  // Core Data Output States
  const [analysisResult, setAnalysisResult] = useState<PrintAnalysisReport | null>(null);
  const [error, setError] = useState<string | null>(null);
  
  // History Catalog States
  const [catalogHistory, setCatalogHistory] = useState<AnalysisHistoryItem[]>([]);
  const [selectedHistoryId, setSelectedHistoryId] = useState<string | null>(null);
  const [isHistoryLoading, setIsHistoryLoading] = useState(true);
  const [currentHistoryItemId, setCurrentHistoryItemId] = useState<string | null>(null);

  // Grouping and Backup states
  const [isGroupedByLot, setIsGroupedByLot] = useState(true);

  // User Authentication States
  const [currentUser, setCurrentUser] = useState<string | null>(() => {
    return localStorage.getItem("print_analyzer_user");
  });
  const [currentUserRole, setCurrentUserRole] = useState<string>("guest");
  const [currentUserName, setCurrentUserName] = useState<string>("");
  const [showAuthModal, setShowAuthModal] = useState(false);
  const [isSignUpMode, setIsSignUpMode] = useState(false);
  const [authUsername, setAuthUsername] = useState("");
  const [authPassword, setAuthPassword] = useState("");
  const [authName, setAuthName] = useState("");
  const [authRole, setAuthRole] = useState("seller");
  const [authError, setAuthError] = useState("");
  const [authSuccess, setAuthSuccess] = useState("");
  const [authLoading, setAuthLoading] = useState(false);

  // Multi-catalogue States
  const [catalogs, setCatalogs] = useState<CatalogMetadata[]>([]);
  const catalogsRef = useRef<CatalogMetadata[]>([]);
  catalogsRef.current = catalogs;
  const [activeCatalogId, setActiveCatalogId] = useState<string>("default");
  const [targetOption, setTargetOption] = useState<"current" | "new">("current");
  const [newCatalogName, setNewCatalogName] = useState("");

  // States for multi-item Lot creation and Gemini proposal
  const [selectedItemIds, setSelectedItemIds] = useState<string[]>([]);
  const [lotNumberInput, setLotNumberInput] = useState("");
  const [lotTitleInput, setLotTitleInput] = useState("");
  const [isLotNumberOverridden, setIsLotNumberOverridden] = useState(false);
  const [isLotTitleOverridden, setIsLotTitleOverridden] = useState(false);
  const [aiProposingLot, setAiProposingLot] = useState(false);

  // Drag and drop state for reordering
  const [draggedIndex, setDraggedIndex] = useState<number | null>(null);
  const [dragOverIndex, setDragOverIndex] = useState<number | null>(null);

  // Column width configuration for tabular record list view
  const [catalogViewMode, setCatalogViewMode] = useState<"inspector" | "tabular">("inspector");
  const [columnWidths, setColumnWidths] = useState<{ [key: string]: number }>({
    checkbox: 50,
    preview: 75,
    titleArtist: 230,
    period: 120,
    technique: 160,
    lot: 100,
    valuation: 170
  });

  const handleResizeStart = (colKey: string, startX: number, startWidth: number) => {
    const handleMouseMove = (moveEvent: MouseEvent) => {
      const deltaX = moveEvent.clientX - startX;
      setColumnWidths((prev) => ({
        ...prev,
        [colKey]: Math.max(50, startWidth + deltaX),
      }));
    };

    const handleMouseUp = () => {
      document.removeEventListener("mousemove", handleMouseMove);
      document.removeEventListener("mouseup", handleMouseUp);
    };

    document.addEventListener("mousemove", handleMouseMove);
    document.addEventListener("mouseup", handleMouseUp);
  };

  // File input refs
  const fileInputRef = useRef<HTMLInputElement>(null);
  const signatureInputRef = useRef<HTMLInputElement>(null);
  const damageInputRef = useRef<HTMLInputElement>(null);
  const scaleInputRef = useRef<HTMLInputElement>(null);

  // Load history from IndexedDB (or server if logged in) on mount
  useEffect(() => {
    const loadHistory = async () => {
      setIsHistoryLoading(true);
      try {
        const username = localStorage.getItem("print_analyzer_user");
        if (username) {
          setCurrentUser(username);
          
          // Fetch user profile on boot to get role & name
          try {
            const profileRes = await fetch("/api/user/profile", {
              headers: { "X-User-Header": username }
            });
            if (profileRes.ok) {
              const profileData = await profileRes.json();
              setCurrentUserRole(profileData.role || "seller");
              setCurrentUserName(profileData.name || "");
            }
          } catch (profileErr) {
            console.error("Failed to load user profile on boot:", profileErr);
          }
          
          const listRes = await fetch("/api/user/catalog-list", {
            headers: { "X-User-Header": username }
          });
          if (listRes.ok) {
            const listData = await listRes.json();
            setCatalogs(listData.catalogs || []);
            setActiveCatalogId(listData.activeCatalogId || "default");
          }
          
          const res = await fetch("/api/user/items", {
            headers: { "X-User-Header": username }
          });
          if (res.ok) {
            const data = await res.json();
            setCatalogHistory(data);
            await setItemDatabaseDB(data);
          }
          setIsHistoryLoading(false);
          return;
        }
        
        const localList = await getCatalogsListDB();
        setCatalogs(localList);
        const localActiveId = await getActiveCatalogIdDB();
        setActiveCatalogId(localActiveId);
        const localItems = await getItemDatabaseDB();
        setCatalogHistory(localItems);
      } catch (err) {
        console.error("Failed to load items database on mount:", err);
      } finally {
        setIsHistoryLoading(false);
      }
    };
    loadHistory();
  }, []);

  // Fetch registered appraisal methods from backend on mount
  useEffect(() => {
    const fetchMethods = async () => {
      try {
        const res = await fetch("/api/appraisal-methods");
        if (res.ok) {
          const data = await res.json();
          if (Array.isArray(data)) {
            setAppraisalMethods(data);
          }
        }
      } catch (err) {
        console.error("Failed to fetch appraisal methods:", err);
      }
    };
    fetchMethods();
  }, []);

  const uploadImagePayload = async (base64Data: string, username: string): Promise<string> => {
    try {
      const res = await fetch("/api/user/upload-scan", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "X-User-Header": username
        },
        body: JSON.stringify({ imageBase64: base64Data })
      });
      if (res.ok) {
        const data = await res.json();
        return data.imageUrl;
      }
    } catch (err) {
      console.error("Failed to upload image payload to server:", err);
    }
    return base64Data;
  };

  const uploadNewScansToServer = async (history: AnalysisHistoryItem[], username: string): Promise<AnalysisHistoryItem[]> => {
    const updatedHistory = [...history];
    for (let i = 0; i < updatedHistory.length; i++) {
      const item = { ...updatedHistory[i] };
      
      // 1. Main image
      if (item.imageUrl && item.imageUrl.startsWith("data:image/")) {
        item.imageUrl = await uploadImagePayload(item.imageUrl, username);
      }
      // 2. Signature image
      if (item.signatureImageUrl && item.signatureImageUrl.startsWith("data:image/")) {
        item.signatureImageUrl = await uploadImagePayload(item.signatureImageUrl, username);
      }
      // 3. Damage image
      if (item.damageImageUrl && item.damageImageUrl.startsWith("data:image/")) {
        item.damageImageUrl = await uploadImagePayload(item.damageImageUrl, username);
      }
      // 4. Scale image
      if (item.scaleImageUrl && item.scaleImageUrl.startsWith("data:image/")) {
        item.scaleImageUrl = await uploadImagePayload(item.scaleImageUrl, username);
      }
      
      updatedHistory[i] = item;
    }
    return updatedHistory;
  };

  // Save history helper (IndexedDB async + Server sync if logged in)
  const updateHistory = async (newHistory: AnalysisHistoryItem[]): Promise<AnalysisHistoryItem[]> => {
    setCatalogHistory(newHistory);
    
    const updatedCatalogs = catalogs.map(c => 
      c.id === activeCatalogId ? { ...c, timestamp: new Date().toISOString() } : c
    );
    setCatalogs(updatedCatalogs);
    
    try {
      await setItemDatabaseDB(newHistory);
      await setCatalogsListDB(updatedCatalogs);
    } catch (err: any) {
      console.error("Failed to persist print analysis library in IndexedDB:", err);
      setError("Failed to save changes to local database.");
    }

    let resultHistory = newHistory;
    if (currentUser) {
      try {
        const syncedHistory = await uploadNewScansToServer(newHistory, currentUser);
        resultHistory = syncedHistory;
        
        const res = await fetch("/api/user/items", {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            "X-User-Header": currentUser
          },
          body: JSON.stringify({ items: syncedHistory })
        });
        
        await fetch("/api/user/catalog-list", {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            "X-User-Header": currentUser
          },
          body: JSON.stringify({ catalogs: updatedCatalogs, activeCatalogId })
        });

        if (res.ok) {
          setCatalogHistory(syncedHistory);
          await setItemDatabaseDB(syncedHistory);
        }
      } catch (serverErr) {
        console.error("Failed to sync items with server:", serverErr);
      }
    }
    return resultHistory;
  };

  const handleSwitchCatalog = async (id: string) => {
    setActiveCatalogId(id);
    
    try {
      await setActiveCatalogIdDB(id);
      
      if (currentUser) {
        await fetch("/api/user/catalog-list", {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            "X-User-Header": currentUser
          },
          body: JSON.stringify({ catalogs, activeCatalogId: id })
        });
      }
    } catch (err) {
      console.error("Failed to switch catalog ID in storage:", err);
    }
  };

  const createNewCatalog = async (name: string): Promise<string> => {
    const finalId = generateUniqueCatalogId(catalogs, currentUser);
    const finalName = name.trim() || `Catalogue ${new Date().toLocaleDateString()}`;

    const newCatalog: CatalogMetadata = {
      id: finalId,
      name: finalName,
      timestamp: new Date().toISOString()
    };

    const updatedCatalogs = [...catalogs, newCatalog];
    setCatalogs(updatedCatalogs);
    setActiveCatalogId(finalId);
    // Note: Do not clear global catalogHistory to keep items visible for allocation

    await setCatalogsListDB(updatedCatalogs);
    await setActiveCatalogIdDB(finalId);
    await setCatalogItemsDB(finalId, []);

    if (currentUser) {
      try {
        await fetch("/api/user/catalog-list", {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            "X-User-Header": currentUser
          },
          body: JSON.stringify({ catalogs: updatedCatalogs, activeCatalogId: finalId })
        });
        await fetch(`/api/user/catalog?id=${finalId}`, {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            "X-User-Header": currentUser
          },
          body: JSON.stringify({ catalog: [] })
        });
      } catch (err) {
        console.error("Failed to sync new catalog to server:", err);
      }
    }

    return finalId;
  };

  // Find an existing catalogue whose name matches the method label, or create one.
  const findOrCreateMethodCatalog = async (methodLabel: string): Promise<string> => {
    const current = catalogsRef.current;
    const existing = current.find(c => c.name === methodLabel);
    if (existing) return existing.id;

    const newId = generateUniqueCatalogId(current, currentUser);
    const newCatalog: CatalogMetadata = {
      id: newId,
      name: methodLabel,
      timestamp: new Date().toISOString(),
    };
    const updatedCatalogs = [...current, newCatalog];
    setCatalogs(updatedCatalogs);
    await setCatalogsListDB(updatedCatalogs);
    await setCatalogItemsDB(newId, []);

    if (currentUser) {
      try {
        await fetch("/api/user/catalog-list", {
          method: "POST",
          headers: { "Content-Type": "application/json", "X-User-Header": currentUser },
          body: JSON.stringify({ catalogs: updatedCatalogs, activeCatalogId }),
        });
      } catch (err) {
        console.error("Failed to sync new method catalogue to server:", err);
      }
    }
    return newId;
  };

  const handleRenameCatalog = async (oldId: string, newId: string, newName: string) => {
    // Keep ID immutable to preserve database relationships and prevent orphan entries
    const finalNewName = newName.trim() || "Untitled Catalogue";

    const updatedCatalogs = catalogs.map(c => 
      c.id === oldId ? { ...c, name: finalNewName, timestamp: new Date().toISOString() } : c
    );

    try {
      await setCatalogsListDB(updatedCatalogs);
      setCatalogs(updatedCatalogs);
    } catch (err) {
      console.error("Local catalog rename failed:", err);
      throw new Error("Failed to rename catalogue in local database.");
    }

    if (currentUser) {
      try {
        await fetch("/api/user/catalog-list", {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            "X-User-Header": currentUser
          },
          body: JSON.stringify({ catalogs: updatedCatalogs, activeCatalogId })
        });
      } catch (err) {
        console.error("Server catalog rename sync failed:", err);
      }
    }
  };

  const handleDeleteCatalog = async (id: string) => {
    setIsHistoryLoading(true);
    try {
      if (currentUser) {
        const res = await fetch("/api/user/delete-catalog", {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            "X-User-Header": currentUser
          },
          body: JSON.stringify({ id })
        });
        if (!res.ok) {
          const data = await res.json();
          throw new Error(data.error || "Failed to delete catalogue on server.");
        }
      }

      const updatedCatalogs = catalogs.filter((c) => c.id !== id);
      const updatedHistory = catalogHistory.map(item => 
        item.catalogue_id === id ? { ...item, catalogue_id: null } : item
      );
      
      let fallbackId = activeCatalogId;
      if (activeCatalogId === id) {
        if (updatedCatalogs.length > 0) {
          fallbackId = updatedCatalogs[0].id;
        } else {
          // Re-create default catalog
          const defaultCatalog: CatalogMetadata = {
            id: "default",
            name: "Default Catalogue",
            timestamp: new Date().toISOString()
          };
          updatedCatalogs.push(defaultCatalog);
          fallbackId = "default";
        }
      }

      setCatalogs(updatedCatalogs);
      setActiveCatalogId(fallbackId);
      await setCatalogsListDB(updatedCatalogs);
      await setActiveCatalogIdDB(fallbackId);
      await updateHistory(updatedHistory);

    } catch (err: any) {
      console.error("Failed to delete catalogue:", err);
      alert(err.message || "Failed to delete catalogue.");
    } finally {
      setIsHistoryLoading(false);
    }
  };

  const handleAuthSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setAuthError("");
    setAuthSuccess("");
    setAuthLoading(true);

    const endpoint = isSignUpMode ? "/api/auth/signup" : "/api/auth/login";
    try {
      const signupBody = isSignUpMode
        ? { username: authUsername, password: authPassword, name: authName, role: authRole }
        : { username: authUsername, password: authPassword };

      const res = await fetch(endpoint, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(signupBody)
      });
      const data = await res.json();
      if (!res.ok) {
        throw new Error(data.error || "Authentication failed.");
      }

      if (isSignUpMode) {
        setAuthSuccess("Account created successfully! Logging you in...");
        setIsSignUpMode(false);
        
        const loggedInUser = data.username;
        await migrateGuestToUserDB(loggedInUser);
        localStorage.setItem("print_analyzer_user", loggedInUser);
        setCurrentUser(loggedInUser);
        setCurrentUserRole(data.role || "seller");
        setCurrentUserName(data.name || "");

        try {
          await fetch("/api/user/catalog-list", {
            method: "POST",
            headers: {
              "Content-Type": "application/json",
              "X-User-Header": loggedInUser
            },
            body: JSON.stringify({ catalogs, activeCatalogId })
          });

          for (const cat of catalogs) {
            const localItems = await getCatalogItemsDB(cat.id);
            const syncedHistory = await uploadNewScansToServer(localItems, loggedInUser);
            
            await setCatalogItemsDB(cat.id, syncedHistory);
            if (cat.id === activeCatalogId) {
              setCatalogHistory(syncedHistory);
            }

            await fetch(`/api/user/catalog?id=${cat.id}`, {
              method: "POST",
              headers: {
                "Content-Type": "application/json",
                "X-User-Header": loggedInUser
              },
              body: JSON.stringify({ catalog: syncedHistory })
            });
          }
        } catch (syncErr) {
          console.error("Failed to sync local catalogues to server on registration:", syncErr);
        }
      } else {
        const loggedInUser = data.username;
        localStorage.setItem("print_analyzer_user", loggedInUser);
        setCurrentUser(loggedInUser);
        setCurrentUserRole(data.role || "seller");
        setCurrentUserName(data.name || "");

        const listRes = await fetch("/api/user/catalog-list", {
          headers: { "X-User-Header": loggedInUser }
        });
        if (listRes.ok) {
          const listData = await listRes.json();
          setCatalogs(listData.catalogs || []);
          setActiveCatalogId(listData.activeCatalogId || "default");
          
          const activeId = listData.activeCatalogId || "default";
          const itemsRes = await fetch("/api/user/items", {
            headers: { "X-User-Header": loggedInUser }
          });
          if (itemsRes.ok) {
            const itemsData = await itemsRes.json();
            setCatalogHistory(itemsData);
            await setItemDatabaseDB(itemsData);
            await setCatalogsListDB(listData.catalogs);
            await setActiveCatalogIdDB(activeId);
          }
        }
      }

      setTimeout(() => {
        setShowAuthModal(false);
        setAuthUsername("");
        setAuthPassword("");
        setAuthSuccess("");
      }, 1000);

    } catch (err: any) {
      setAuthError(err.message || "Something went wrong.");
    } finally {
      setAuthLoading(false);
    }
  };

  const handleLogout = async () => {
    localStorage.removeItem("print_analyzer_user");
    setCurrentUser(null);
    setCurrentUserRole("guest");
    setCurrentUserName("");
    setIsHistoryLoading(true);
    try {
      const localList = await getCatalogsListDB();
      setCatalogs(localList);
      const localActiveId = await getActiveCatalogIdDB();
      setActiveCatalogId(localActiveId);
      const localItems = await getCatalogItemsDB(localActiveId);
      setCatalogHistory(localItems);
    } catch (err) {
      console.error("Failed to restore local catalogs on logout:", err);
    } finally {
      setIsHistoryLoading(false);
    }
  };

  // Helper: File Base64 encoder
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

  // File size formatter helper
  const formatBytes = (bytes: number) => {
    if (bytes === 0) return "0 Bytes";
    const k = 1024;
    const sizes = ["Bytes", "KB", "MB"];
    const i = Math.floor(Math.log(bytes) / Math.log(k));
    return parseFloat((bytes / Math.pow(k, i)).toFixed(1)) + " " + sizes[i];
  };

  // Handle selected file triggers
  const handleFileSelection = (file: File) => {
    if (!file.type.startsWith("image/")) {
      setError("Supported file types are limited to images (PNG, JPEG, WEBP).");
      return;
    }
    
    // Clear old result and error
    setAnalysisResult(null);
    setError(null);
    setSelectedFile(file);
    
    // Set preview
    const url = URL.createObjectURL(file);
    setPreviewUrl(url);
  };

  // Drag Events Handlers
  const handleDrag = (e: React.DragEvent) => {
    e.preventDefault();
    e.stopPropagation();
    if (e.type === "dragenter" || e.type === "dragover") {
      setDragActive(true);
    } else if (e.type === "dragleave") {
      setDragActive(false);
    }
  };

  const handleDrop = (e: React.DragEvent) => {
    e.preventDefault();
    e.stopPropagation();
    setDragActive(false);
    if (e.dataTransfer.files && e.dataTransfer.files[0]) {
      handleFileSelection(e.dataTransfer.files[0]);
    }
  };

  const triggerFileInput = () => {
    fileInputRef.current?.click();
  };

  const clearSelection = () => {
    setSelectedFile(null);
    if (previewUrl) {
      URL.revokeObjectURL(previewUrl);
    }
    setPreviewUrl(null);
    
    setSignatureFile(null);
    if (signaturePreview) {
      URL.revokeObjectURL(signaturePreview);
    }
    setSignaturePreview(null);
    
    setDamageFile(null);
    if (damagePreview) {
      URL.revokeObjectURL(damagePreview);
    }
    setDamagePreview(null);
    
    setScaleFile(null);
    if (scalePreview) {
      URL.revokeObjectURL(scalePreview);
    }
    setScalePreview(null);

    setAnalysisResult(null);
    setError(null);
    setUserNotes("");
    setProvenanceNotes("");
    setConditionNotes("");
    setLiteratureNotes("");
    setCurrentHistoryItemId(null);
  };

  // core handler to analyze print with real server-side Gemini
  const handleAnalysisSubmit = async () => {
    if (!selectedFile) {
      setError("Please select or drop an image file to analyze first.");
      return;
    }

    setIsLoading(true);
    setError(null);
    setLoadingProgress(5);
    setLoadingStep("Preparing image for digitized transmission...");

    const abort = new AbortController();
    abortControllerRef.current = abort;
    const signal = abort.signal;

    try {
      // Step simulated progress cycles
      const interval = setInterval(() => {
        setLoadingProgress((prev) => {
          if (prev >= 92) return prev;
          if (prev < 20) return prev + 15;
          if (prev < 50) return prev + 8;
          return prev + 3;
        });
      }, 550);

      // Map progress text based on current values
      const progressTextTimer = setInterval(() => {
        setLoadingProgress((val) => {
          if (val < 20) {
            setLoadingStep("Calibrating optical details and surface color gamut...");
          } else if (val < 45) {
            setLoadingStep("Scanning global database of woodcut, litho, and screenprint matrices...");
          } else if (val < 70) {
            setLoadingStep("Probing for paper foxing, mat acid-burns, and signature status...");
          } else if (val < 90) {
            setLoadingStep("Cross-referencing global auction records for current speculation guides...");
          } else {
            setLoadingStep("Synthesizing final paper curator report statement...");
          }
          return val;
        });
      }, 900);

      const selectedMethodConfig = appraisalMethods.find(m => m.id === appraisalMethod);
      const targetQuality = selectedMethodConfig?.imageQuality || "original";
      const includeAux = selectedMethodConfig ? selectedMethodConfig.includeAuxiliaryScans : true;

      const base64Data = await fileToBase64(selectedFile);
      const processedBase64 = await resizeImageIfNeeded(base64Data, targetQuality);

      let signatureBase64 = undefined;
      let signatureMimeType = undefined;
      if (includeAux && signatureFile) {
        const rawSigBase64 = await fileToBase64(signatureFile);
        signatureBase64 = await resizeImageIfNeeded(rawSigBase64, targetQuality);
        signatureMimeType = signatureFile.type;
      }

      let damageBase64 = undefined;
      let damageMimeType = undefined;
      if (includeAux && damageFile) {
        const rawDmgBase64 = await fileToBase64(damageFile);
        damageBase64 = await resizeImageIfNeeded(rawDmgBase64, targetQuality);
        damageMimeType = damageFile.type;
      }

      let scaleBase64 = undefined;
      let scaleMimeType = undefined;
      if (includeAux && scaleFile) {
        const rawScaleBase64 = await fileToBase64(scaleFile);
        scaleBase64 = await resizeImageIfNeeded(rawScaleBase64, targetQuality);
        scaleMimeType = scaleFile.type;
      }

      // Compile all user-provided notes to support valuation
      let compiledNotes = "";
      if (userNotes.trim()) {
        compiledNotes += `[Inscribed Marks & Monograms]: ${userNotes.trim()}\n`;
      }
      if (provenanceNotes.trim()) {
        compiledNotes += `[Provenance & Ownership History]: ${provenanceNotes.trim()}\n`;
      }
      if (conditionNotes.trim()) {
        compiledNotes += `[Physical Condition & Framing]: ${conditionNotes.trim()}\n`;
      }
      if (literatureNotes.trim()) {
        compiledNotes += `[Literature & Catalogue References]: ${literatureNotes.trim()}\n`;
      }

      // Call collage detection
      setLoadingStep("Checking for multi-artwork collage layout...");
      const detectRes = await fetch("/api/detect-artworks", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ imageBase64: base64Data, mimeType: selectedFile.type }),
        signal,
      });
      if (!detectRes.ok) {
        const errData = await detectRes.json().catch(() => ({}));
        throw new Error(errData.error || "Collage detection failed.");
      }
      const detection = await detectRes.json();

      const splitItems: AnalysisHistoryItem[] = [];
      const randomCode = Math.random().toString(36).substring(2, 6).toUpperCase();
      const cleanName = selectedFile.name.substring(0, 8).replace(/[^a-zA-Z0-9]/g, "");
      const sharedLotNumber = `Lot S-${cleanName}-${randomCode}`;
      const sharedLotTitle = `Split Group Lot: ${selectedFile.name}`;

      if (detection.containsMultipleArtworks && detection.artworks.length > 1) {
        setLoadingStep(`Collage scan detected! Splitting into ${detection.artworks.length} items...`);
        for (let j = 0; j < detection.artworks.length; j++) {
          const art = detection.artworks[j];
          setLoadingStep(`Slicing cropped artwork: ${art.label}...`);
          const croppedBase64 = await cropImageCanvas(base64Data, art.box_2d);
          const processedCroppedBase64 = await resizeImageIfNeeded(croppedBase64, targetQuality);

          setLoadingStep(`Appraising item [${j + 1}/${detection.artworks.length}]: ${art.label}...`);
          const analyzeRes = await fetch("/api/analyze-print", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
              imageBase64: processedCroppedBase64,
              mimeType: "image/jpeg",
              currency,
              method: appraisalMethod
            }),
            signal,
          });
          if (!analyzeRes.ok) {
            const errData = await analyzeRes.json().catch(() => ({}));
            throw new Error(errData.error || `Appraisal of ${art.label} failed.`);
          }
          const report: PrintAnalysisReport = await analyzeRes.json();

          const historyItem: AnalysisHistoryItem = {
            id: crypto.randomUUID(),
            timestamp: new Date().toLocaleDateString("en-US", {
              month: "short",
              day: "numeric",
              year: "numeric",
              hour: "2-digit",
              minute: "2-digit",
            }),
            imageUrl: processedCroppedBase64,
            imageFileName: `${selectedFile.name}_${art.label.replace(/\s+/g, "_")}.jpg`,
            imageSize: "Split Scan Crop",
            report,
            lotNumber: sharedLotNumber,
            lotTitle: sharedLotTitle
          };
          splitItems.push(historyItem);
        }
      } else {
        // Single piece detected.
        setLoadingStep("Appraising print sheet...");
        const analyzeRes = await fetch("/api/analyze-print", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            imageBase64: processedBase64,
            mimeType: selectedFile.type,
            userNotes: compiledNotes.trim() || undefined,
            signatureBase64,
            signatureMimeType,
            damageBase64,
            damageMimeType,
            scaleBase64,
            scaleMimeType,
            currency,
            method: appraisalMethod
          }),
          signal,
        });
        if (!analyzeRes.ok) {
          const errData = await analyzeRes.json().catch(() => ({}));
          throw new Error(errData.error || "Detailed print appraisal analysis failed.");
        }
        const report: PrintAnalysisReport = await analyzeRes.json();

        let thumbnailImg = previewUrl || "";
        try {
          thumbnailImg = await generateThumbnail(selectedFile, 300, 300);
        } catch (thumbErr) {
          console.warn("Could not generate thumbnail:", thumbErr);
        }

        const historyItem: AnalysisHistoryItem = {
          id: crypto.randomUUID(),
          timestamp: new Date().toLocaleDateString("en-US", {
            month: "short",
            day: "numeric",
            year: "numeric",
            hour: "2-digit",
            minute: "2-digit",
          }),
          imageUrl: thumbnailImg || (base64Data.startsWith("data:") ? base64Data : `data:${selectedFile.type};base64,${base64Data}`),
          imageFileName: selectedFile.name || "Uploaded_Print.png",
          imageSize: formatBytes(selectedFile.size),
          report,
          signatureImageUrl: signaturePreview || undefined,
          damageImageUrl: damagePreview || undefined,
          scaleImageUrl: scalePreview || undefined,
        };
        splitItems.push(historyItem);
      }

      clearInterval(interval);
      clearInterval(progressTextTimer);

      // Auto-assign items to a per-method catalogue
      if (splitItems.length > 0) {
        const methodLabel = resolveMethodLabel(
          splitItems[0].report.promptVersion || "standard",
          splitItems[0].report.modelUsed || ""
        );
        const methodCatalogId = await findOrCreateMethodCatalog(methodLabel);
        splitItems.forEach(item => { item.catalogue_id = methodCatalogId; });
      }

      const newHistory = [...splitItems, ...catalogHistory];
      await updateHistory(newHistory);

      if (splitItems.length > 0) {
        setCurrentHistoryItemId(splitItems[0].id);
        setAnalysisResult(splitItems[0].report);
        setPreviewUrl(splitItems[0].imageUrl);
      }

      setLoadingProgress(100);
      setLoadingStep("Curation statement complete!");
      setTimeout(() => {
        setIsLoading(false);
      }, 300);

    } catch (err: any) {
      if (err.name === "AbortError") {
        setLoadingStep("Analysis stopped.");
      } else {
        console.error(err);
        setError(
          err.message && err.message !== "Failed to fetch"
            ? err.message
            : "The analysis timed out or the server is unreachable. The 4-stage pipeline can take 3–4 minutes — if this keeps happening, try a faster appraisal method."
        );
      }
      setIsLoading(false);
    } finally {
      abortControllerRef.current = null;
    }
  };

  const handleStopAnalysis = () => {
    abortControllerRef.current?.abort();
  };

  const handleHistoryDragStart = (e: React.DragEvent, index: number) => {
    setDraggedIndex(index);
    e.dataTransfer.effectAllowed = "move";
  };

  const handleHistoryDragOver = (e: React.DragEvent, index: number) => {
    e.preventDefault();
    if (draggedIndex === null || draggedIndex === index) return;
    setDragOverIndex(index);
  };

  const handleHistoryDrop = (e: React.DragEvent, targetIndex: number) => {
    e.preventDefault();
    if (draggedIndex === null || draggedIndex === targetIndex) return;

    const list = catalogHistory.map(it => ({ ...it }));
    const draggedItem = list[draggedIndex];
    const targetItem = list[targetIndex];

    // Dragging individual items out of group lots / changing their groups:
    // Update the lot information of the dragged item to match the target's lot
    if (isGroupedByLot) {
      draggedItem.lotNumber = targetItem.lotNumber;
      draggedItem.lotTitle = targetItem.lotTitle;
    }

    list.splice(draggedIndex, 1);
    list.splice(targetIndex, 0, draggedItem);

    updateHistory(list);
    
    setDraggedIndex(null);
    setDragOverIndex(null);
  };

  const handleHistoryDragEnd = () => {
    setDraggedIndex(null);
    setDragOverIndex(null);
  };

  const autoGenerateLotForSelection = (
    nextSelection: string[],
    overrideLotNum?: string,
    overrideLotTitle?: string,
    aiResponse?: { proposedLotNumber?: string; proposedLotTitle?: string },
    forceRecalculate?: boolean
  ) => {
    if (nextSelection.length === 0) {
      if (!isLotNumberOverridden && !forceRecalculate) setLotNumberInput("");
      if (!isLotTitleOverridden && !forceRecalculate) setLotTitleInput("");
      if (forceRecalculate) {
        setLotNumberInput("");
        setLotTitleInput("");
      }
      
      const updated = catalogHistory.map(item => {
        if (selectedItemIds.includes(item.id)) {
          return { ...item, lotNumber: undefined, lotTitle: undefined };
        }
        return item;
      });
      updateHistory(updated);
      return;
    }

    const selectedItems = catalogHistory.filter(item => nextSelection.includes(item.id));
    if (selectedItems.length === 0) return;

    // Determine the Lot Number
    let finalLotNumber = lotNumberInput;
    const numOverridden = forceRecalculate ? false : isLotNumberOverridden;
    if (overrideLotNum !== undefined) {
      finalLotNumber = overrideLotNum;
    } else if (aiResponse?.proposedLotNumber && !numOverridden) {
      finalLotNumber = aiResponse.proposedLotNumber;
    } else if (!numOverridden || !finalLotNumber) {
      const assignedLotsCount = catalogHistory.filter(it => it.lotNumber && !nextSelection.includes(it.id)).length;
      finalLotNumber = `Lot ${101 + assignedLotsCount * 5}`;
    }

    // Determine the Lot Title
    let finalLotTitle = lotTitleInput;
    const titleOverridden = forceRecalculate ? false : isLotTitleOverridden;
    if (overrideLotTitle !== undefined) {
      finalLotTitle = overrideLotTitle;
    } else if (aiResponse?.proposedLotTitle && !titleOverridden) {
      finalLotTitle = aiResponse.proposedLotTitle;
    } else if (!titleOverridden || !finalLotTitle) {
      const uniqueArtists = Array.from(new Set(selectedItems.map(it => it.report.likelyArtist).filter(Boolean)));
      const uniqueTechniques = Array.from(new Set(selectedItems.map(it => it.report.techniques?.[0]?.technique).filter(Boolean)));
      
      if (uniqueArtists.length === 1 && uniqueArtists[0] && uniqueArtists[0] !== "Unknown Artist" && uniqueArtists[0] !== "Unknown") {
        finalLotTitle = `${uniqueArtists[0]} Prints Portfolio`;
      } else if (uniqueArtists.length > 1) {
        const displayArtists = uniqueArtists.filter(a => a !== "Unknown Artist" && a !== "Unknown");
        if (displayArtists.length > 0) {
          finalLotTitle = `Selected Prints & Work: ${displayArtists.slice(0, 2).join(" & ")}`;
        } else {
          finalLotTitle = `Group Portfolio: Contemporary Impressions`;
        }
      } else if (uniqueTechniques.length > 0 && uniqueTechniques[0]) {
        finalLotTitle = `Cohesive Run of ${uniqueTechniques[0]} Impresses`;
      } else {
        finalLotTitle = `Unified Catalog Lot Grouping`;
      }
    }

    if ((!numOverridden && finalLotNumber !== lotNumberInput) || forceRecalculate) {
      setLotNumberInput(finalLotNumber);
    }
    if ((!titleOverridden && finalLotTitle !== lotTitleInput) || forceRecalculate) {
      setLotTitleInput(finalLotTitle);
    }

    const updated = catalogHistory.map(item => {
      if (nextSelection.includes(item.id)) {
        return {
          ...item,
          lotNumber: finalLotNumber || undefined,
          lotTitle: finalLotTitle || undefined
        };
      } else if (selectedItemIds.includes(item.id) && !nextSelection.includes(item.id)) {
        return {
          ...item,
          lotNumber: undefined,
          lotTitle: undefined
        };
      }
      return item;
    });

    updateHistory(updated);
  };

  const fetchBgGeminiForSelection = async (nextSelection: string[], forceRecalculate?: boolean) => {
    if (nextSelection.length === 0) return;
    const selectedItems = catalogHistory.filter(item => nextSelection.includes(item.id));
    if (selectedItems.length === 0) return;

    try {
      setAiProposingLot(true);
      const selectedItemsData = selectedItems.map(item => ({
        title: item.report.artworkTitle,
        artist: item.report.likelyArtist,
        period: item.report.creationPeriod,
        techniques: item.report.techniques?.map((t: any) => t.technique) || []
      }));

      const response = await fetch("/api/propose-lot-name", {
        method: "POST",
        headers: {
          "Content-Type": "application/json"
        },
        body: JSON.stringify({ items: selectedItemsData })
      });

      if (!response.ok) {
        throw new Error(`HTTP error ${response.status}`);
      }

      const data = await response.json();
      autoGenerateLotForSelection(nextSelection, undefined, undefined, data, forceRecalculate);
    } catch (err) {
      console.error("Background auto lot proposal failed:", err);
    } finally {
      setAiProposingLot(false);
    }
  };

  const toggleItemSelection = (id: string) => {
    const exists = selectedItemIds.includes(id);
    const nextSelection = exists ? selectedItemIds.filter(itemId => itemId !== id) : [...selectedItemIds, id];
    
    const isAdded = !exists;
    if (isAdded) {
      setIsLotNumberOverridden(false);
      setIsLotTitleOverridden(false);
      autoGenerateLotForSelection(nextSelection, undefined, undefined, undefined, true);
      fetchBgGeminiForSelection(nextSelection, true);
    } else {
      autoGenerateLotForSelection(nextSelection);
      if (nextSelection.length > 0) {
        fetchBgGeminiForSelection(nextSelection);
      }
    }
    
    setSelectedItemIds(nextSelection);
  };

  const handleLotNumberInputChange = (val: string) => {
    setLotNumberInput(val);
    setIsLotNumberOverridden(true);
    const updated = catalogHistory.map(item => {
      if (selectedItemIds.includes(item.id)) {
        return {
          ...item,
          lotNumber: val.trim() || undefined
        };
      }
      return item;
    });
    updateHistory(updated);
  };

  const handleLotTitleInputChange = (val: string) => {
    setLotTitleInput(val);
    setIsLotTitleOverridden(true);
    const updated = catalogHistory.map(item => {
      if (selectedItemIds.includes(item.id)) {
        return {
          ...item,
          lotTitle: val.trim() || undefined
        };
      }
      return item;
    });
    updateHistory(updated);
  };

  const updateItemLot = (id: string, lotNumber: string, lotTitle: string) => {
    const targetItem = catalogHistory.find(item => item.id === id);
    const oldLotNumber = targetItem?.lotNumber;

    const updated = catalogHistory.map(item => {
      // Cohesive update if it is part of the active selection
      if (selectedItemIds.includes(id) && selectedItemIds.includes(item.id)) {
        return {
          ...item,
          lotNumber: lotNumber.trim() || undefined,
          lotTitle: lotTitle.trim() || undefined
        };
      }
      // Cohesive update if it belongs to the same historical lot group
      if (oldLotNumber && item.lotNumber === oldLotNumber) {
        return {
          ...item,
          lotNumber: lotNumber.trim() || undefined,
          lotTitle: lotTitle.trim() || undefined
        };
      }
      if (item.id === id) {
        return {
          ...item,
          lotNumber: lotNumber.trim() || undefined,
          lotTitle: lotTitle.trim() || undefined
        };
      }
      return item;
    });
    updateHistory(updated);
  };

  const updateItemCatalogue = (id: string, catalogueId: string | null) => {
    const updated = catalogHistory.map((item) => {
      if (item.id === id) {
        return { ...item, catalogue_id: catalogueId };
      }
      return item;
    });
    updateHistory(updated);
  };

  const updateMultipleItemsCatalogue = (ids: string[], catalogueId: string | null) => {
    const updated = catalogHistory.map((item) => {
      if (ids.includes(item.id)) {
        return { ...item, catalogue_id: catalogueId };
      }
      return item;
    });
    updateHistory(updated);
  };

  const downloadJsonBackup = () => {
    const cleanData = catalogHistory.map(({ id, timestamp, imageFileName, imageSize, report, lotNumber, lotTitle }) => ({
      archiveId: id,
      timestamp,
      imageFileName,
      imageSize,
      lotNumber: lotNumber || "Unassigned",
      lotTitle: lotTitle || "Unassigned General Collection",
      artistName: report.likelyArtist,
      artworkTitle: report.artworkTitle,
      creationPeriod: report.creationPeriod,
      dimensions: report.inferredDimensions || "Standard dimensions (unmeasured)",
      valuation: report.auctionEstimate.formattedEstimate,
      details: report.conditionNotes.analysisDetails
    }));
    const dataStr = "data:text/json;charset=utf-8," + encodeURIComponent(JSON.stringify(cleanData, null, 2));
    const downloadAnchor = document.createElement("a");
    downloadAnchor.setAttribute("href", dataStr);
    downloadAnchor.setAttribute("download", `printmaster_appraisals_${new Date().toISOString().split("T")[0]}.json`);
    document.body.appendChild(downloadAnchor);
    downloadAnchor.click();
    downloadAnchor.remove();
  };



  const deleteHistoryItem = (id: string, e: React.MouseEvent) => {
    e.stopPropagation();
    const updated = catalogHistory.filter(item => item.id !== id);
    updateHistory(updated);
    if (selectedHistoryId === id) {
      setSelectedHistoryId(null);
    }
  };

  const handleUpdateReport = (updatedReport: PrintAnalysisReport) => {
    setAnalysisResult(updatedReport);
    if (currentHistoryItemId) {
      const updated = catalogHistory.map(item => {
        if (item.id === currentHistoryItemId) {
          return { ...item, report: updatedReport };
        }
        return item;
      });
      updateHistory(updated);
    }
  };

  return (
    <div className="min-h-screen bg-rosebery-cream-bg text-rosebery-text-normal font-sans antialiased pb-20 selection:bg-[#EAE4DB] relative">
      {/* Visual background framing texture */}
      <div className="absolute inset-0 pointer-events-none opacity-[0.03] bg-[radial-gradient(#4C0B2A_1.5px,transparent_1.5px)] [background-size:20px_20px]" />

      <header className="border-b border-[#3E0A22] bg-rosebery-primary relative z-10 shadow-lg pb-4.5">
        <div className="max-w-6xl mx-auto px-6 pt-5 md:pt-6 flex flex-col sm:flex-row items-center justify-between gap-4">
          <div className="text-center sm:text-left flex items-center gap-3.5">
            <div className="bg-[#C0AA84] text-rosebery-primary p-2.5 rounded-sm shadow-gallery-deep">
              <Compass className="w-6 h-6 stroke-[1.5]" />
            </div>
            <div>
              <h1 className="text-xl md:text-2xl font-serif font-black tracking-widest text-white uppercase">
                PrintMasterAI
              </h1>
              <p className="text-[10px] font-mono text-[#D7C3A2] uppercase tracking-[0.25em] mt-0.5 font-medium">
                Archival Print Identification & Appraisals
              </p>
            </div>
          </div>

          {/* Top Line: Settings & User Account Auth */}
          <div className="flex items-center gap-3">
            <button
              onClick={() => setActiveTab("settings")}
              className={`flex items-center gap-1.5 px-4.5 py-2.5 text-xs font-semibold uppercase tracking-wider transition-all duration-200 cursor-pointer rounded-sm border ${
                activeTab === "settings"
                  ? "bg-[#C0AA84] text-rosebery-charcoal border-[#C0AA84] shadow-gallery-deep"
                  : "text-[#D2B4C2] border-[#5A1033] bg-[#3D0821] hover:text-white"
              }`}
            >
              <Settings className="w-3.5 h-3.5" />
              Settings
            </button>

            {currentUser ? (
              <div className="flex items-center gap-1.5 bg-[#3D0821] p-1 rounded-sm border border-[#5A1033] text-white">
                <span className="text-xs font-mono px-2.5 py-1 text-[#D7C3A2] font-semibold truncate max-w-[200px] flex items-center gap-1">
                  <User className="w-3 h-3 text-[#C0AA84]" />
                  {currentUser} ({currentUserRole})
                </span>
                <button
                  onClick={handleLogout}
                  className="bg-rose-900 hover:bg-rose-950 text-white text-[10px] uppercase tracking-wider font-bold px-3 py-2 rounded-xs transition-all duration-200 cursor-pointer border border-rose-950/40"
                >
                  Logout
                </button>
              </div>
            ) : (
              <button
                onClick={() => {
                  setIsSignUpMode(false);
                  setShowAuthModal(true);
                }}
                className="bg-[#C0AA84] hover:bg-[#D7C3A2] text-rosebery-primary text-[10px] uppercase tracking-wider font-bold px-4 py-3 rounded-sm transition-all duration-200 shadow-md cursor-pointer border-none"
              >
                Login / Register
              </button>
            )}
          </div>
        </div>

        {/* Second Line: Main Navigation Tabs */}
        <div className="max-w-6xl mx-auto px-6 mt-4 flex justify-end animate-fadeIn">
          <div className="flex bg-[#3D0821] p-1 rounded-sm border border-[#5A1033] w-full sm:w-auto">
            <button
              onClick={() => setActiveTab("sandbox")}
              className={`flex-1 sm:flex-initial flex items-center justify-center gap-1.5 px-5 py-2.5 text-xs font-semibold uppercase tracking-wider transition-all duration-200 cursor-pointer ${
                activeTab === "sandbox"
                  ? "bg-[#C0AA84] text-rosebery-charcoal rounded-sm shadow-gallery-deep"
                  : "text-[#D2B4C2] hover:text-white"
              }`}
            >
              <Sparkles className="w-3.5 h-3.5" />
              New Appraisal
            </button>
            <button
              onClick={() => setActiveTab("batch")}
              className={`flex-1 sm:flex-initial flex items-center justify-center gap-1.5 px-5 py-2.5 text-xs font-semibold uppercase tracking-wider transition-all duration-200 cursor-pointer ${
                activeTab === "batch"
                  ? "bg-[#C0AA84] text-rosebery-charcoal rounded-sm shadow-gallery-deep"
                  : "text-[#D2B4C2] hover:text-white"
              }`}
            >
              <Layers className="w-3.5 h-3.5" />
              Batch Appraisal
            </button>
            <button
              onClick={() => setActiveTab("history")}
              className={`flex-1 sm:flex-initial flex items-center justify-center gap-1.5 px-5 py-2.5 text-xs font-semibold uppercase tracking-wider transition-all duration-200 relative cursor-pointer ${
                activeTab === "history"
                  ? "bg-[#C0AA84] text-rosebery-charcoal rounded-sm shadow-gallery-deep"
                  : "text-[#D2B4C2] hover:text-white"
              }`}
            >
              <History className="w-3.5 h-3.5" />
              Review Catalog
              {catalogHistory.length > 0 && (
                <span className={`absolute -top-1.5 -right-1.5 flex h-4 w-4 items-center justify-center rounded-full text-[9px] font-bold ${
                  activeTab === "history" ? "bg-[#4B0B29] text-white" : "bg-[#C0AA84] text-rosebery-charcoal"
                }`}>
                  {catalogHistory.length}
                </span>
              )}
            </button>
            {currentUserRole === "admin" && (
              <button
                onClick={() => setActiveTab("admin")}
                className={`flex-1 sm:flex-initial flex items-center justify-center gap-1.5 px-5 py-2.5 text-xs font-semibold uppercase tracking-wider transition-all duration-200 cursor-pointer ${
                  activeTab === "admin"
                    ? "bg-[#C0AA84] text-rosebery-charcoal rounded-sm shadow-gallery-deep"
                    : "text-[#D2B4C2] hover:text-white"
                }`}
              >
                <Award className="w-3.5 h-3.5" />
                Prompt Manager
              </button>
            )}
          </div>
        </div>
      </header>

      {/* Main content compartment */}
      <main className="max-w-6xl mx-auto px-6 mt-10 relative z-10">

        {/* Tab content switcher */}
        {activeTab === "sandbox" ? (
          <div id="sandbox-workspace" className="space-y-8">
            
            {/* Workspace Area: Inputs or interactive results */}
            {!analysisResult && !isLoading ? (
              <div className="bg-rosebery-card border border-rosebery-border rounded-sm p-6 md:p-8 shadow-gallery-soft animate-fadeIn">
                <div className="grid grid-cols-1 lg:grid-cols-12 gap-8 items-start">
                  
                  {/* Left Column: Image Upload & Technical Details */}
                  <UploadPanel
                    selectedFile={selectedFile}
                    previewUrl={previewUrl}
                    dragActive={dragActive}
                    onDrag={handleDrag}
                    onDrop={handleDrop}
                    onFileSelect={handleFileSelection}
                    onClear={clearSelection}
                    fileInputRef={fileInputRef}
                    signaturePreview={signaturePreview}
                    setSignatureFile={setSignatureFile}
                    setSignaturePreview={setSignaturePreview}
                    signatureInputRef={signatureInputRef}
                    damagePreview={damagePreview}
                    setDamageFile={setDamageFile}
                    setDamagePreview={setDamagePreview}
                    damageInputRef={damageInputRef}
                    scalePreview={scalePreview}
                    setScaleFile={setScaleFile}
                    setScalePreview={setScalePreview}
                    scaleInputRef={scaleInputRef}
                  />

                  {/* Right Column: Supporting Notes */}
                  <AppraiserNotesInput
                    userNotes={userNotes}
                    setUserNotes={setUserNotes}
                    provenanceNotes={provenanceNotes}
                    setProvenanceNotes={setProvenanceNotes}
                    conditionNotes={conditionNotes}
                    setConditionNotes={setConditionNotes}
                    literatureNotes={literatureNotes}
                    setLiteratureNotes={setLiteratureNotes}
                    selectedFile={selectedFile}
                    error={error}
                    onSubmit={handleAnalysisSubmit}
                    appraisalMethod={appraisalMethod}
                    setAppraisalMethod={setAppraisalMethod}
                    appraisalMethods={appraisalMethods}
                  />

                </div>
              </div>
            ) : null}

            {/* Scanning details loadings */}
            {isLoading && (
              <div className="bg-rosebery-card border border-rosebery-border rounded-sm p-10 md:p-16 text-center shadow-gallery-soft space-y-6 max-w-xl mx-auto animate-fadeIn">
                <div className="relative w-16 h-16 mx-auto">
                  {/* Sleek dual spinning rings */}
                  <div className="absolute inset-0 rounded-full border-4 border-rosebery-border" />
                  <div className="absolute inset-0 rounded-full border-4 border-t-[#4C0B2A] animate-spin" />
                </div>
                
                <div className="space-y-2.5">
                  <span className="text-[10px] font-mono tracking-[0.25em] text-rosebery-primary uppercase block font-semibold">
                    MAGNIFICATION MATRIX ACTIVE
                  </span>
                  <h3 className="text-lg font-serif font-medium text-rosebery-charcoal tracking-wide">
                    {loadingStep}
                  </h3>
                </div>

                {/* Nice progress indicators */}
                <div className="w-full bg-[#E8E2D7] h-1.5 rounded-full overflow-hidden">
                  <div 
                    className="bg-rosebery-primary h-full rounded-full transition-all duration-300"
                    style={{ width: `${loadingProgress}%` }}
                  />
                </div>
                <span className="text-[11px] font-mono text-rosebery-muted block">
                  {loadingProgress}% Analytically Computed
                </span>
                <button
                  onClick={handleStopAnalysis}
                  className="mt-2 px-4 py-1.5 text-xs font-mono uppercase tracking-wider text-rosebery-muted border border-rosebery-border rounded hover:border-rosebery-primary hover:text-rosebery-primary transition-colors"
                >
                  Stop Analysis
                </button>
              </div>
            )}

            {/* Complete analyzed results report */}
            {analysisResult && !isLoading && (
              <div className="space-y-6">
                
                {/* Reset workspace control bar */}
                <div className="flex justify-between items-center bg-rosebery-card border border-rosebery-border rounded-sm px-5 py-3 shadow-xs">
                  <div className="flex items-center gap-2.5">
                    <span className="flex h-2.5 w-2.5 relative">
                      <span className="animate-ping absolute inline-flex h-full w-full rounded-full bg-rosebery-primary opacity-75"></span>
                      <span className="relative inline-flex rounded-full h-2.5 w-2.5 bg-rosebery-primary"></span>
                    </span>
                    <span className="text-[10px] font-mono text-rosebery-primary uppercase tracking-wider font-semibold">
                      ARCHIVE APPRAISAL COMPLETED
                    </span>
                  </div>
                  
                  <button
                    onClick={clearSelection}
                    className="text-xs text-rosebery-primary hover:text-white font-bold flex items-center gap-1.5 border border-rosebery-primary hover:bg-rosebery-primary px-4 py-2 rounded-sm transition-all cursor-pointer bg-transparent"
                  >
                    <RotateCcw className="w-3.5 h-3.5" />
                    APPRAISE ANOTHER PRINT
                  </button>
                </div>

                {/* Core Report view component */}
                <ReportView 
                  report={analysisResult} 
                  fileName={selectedFile?.name || (currentHistoryItemId ? catalogHistory.find(i => i.id === currentHistoryItemId)?.imageFileName : undefined)}
                  fileSize={selectedFile?.size ? formatBytes(selectedFile.size) : (currentHistoryItemId ? catalogHistory.find(i => i.id === currentHistoryItemId)?.imageSize : undefined)}
                  imageUrl={previewUrl || undefined}
                  signatureFile={signatureFile}
                  signaturePreview={signaturePreview}
                  setSignatureFile={setSignatureFile}
                  setSignaturePreview={setSignaturePreview}
                  signatureInputRef={signatureInputRef}
                  damageFile={damageFile}
                  damagePreview={damagePreview}
                  setDamageFile={setDamageFile}
                  setDamagePreview={setDamagePreview}
                  damageInputRef={damageInputRef}
                  scaleFile={scaleFile}
                  scalePreview={scalePreview}
                  setScaleFile={setScaleFile}
                  setScalePreview={setScalePreview}
                  scaleInputRef={scaleInputRef}
                  onReAnalyze={handleAnalysisSubmit}
                  isLoading={isLoading}
                  currency={currency}
                  setCurrency={setCurrency}
                  onUpdateReport={handleUpdateReport}
                  userRole={currentUserRole}
                  curatorName={currentUserName || currentUser || "Curator"}
                />

              </div>
            )}

          </div>
        ) : activeTab === "batch" ? (
          <BatchProcessor 
            itemDatabase={catalogHistory} 
            updateHistory={updateHistory} 
            currency={currency} 
            appraisalMethod={appraisalMethod}
            setAppraisalMethod={setAppraisalMethod}
            appraisalMethods={appraisalMethods}
          />
        ) : activeTab === "history" ? (
          /* Collection Catalog Library log view */
          <CatalogListView
            isHistoryLoading={isHistoryLoading}
            catalogHistory={catalogHistory}
            selectedHistoryId={selectedHistoryId}
            setSelectedHistoryId={setSelectedHistoryId}
            selectedItemIds={selectedItemIds}
            setSelectedItemIds={setSelectedItemIds}
            toggleItemSelection={toggleItemSelection}
            updateItemLot={updateItemLot}
            updateItemCatalogue={updateItemCatalogue}
            deleteHistoryItem={deleteHistoryItem}

            catalogViewMode={catalogViewMode}
            setCatalogViewMode={setCatalogViewMode}
            currency={currency}
            setCurrency={setCurrency}
            columnWidths={columnWidths}
            setColumnWidths={setColumnWidths}
            handleResizeStart={handleResizeStart}
            lotNumberInput={lotNumberInput}
            lotTitleInput={lotTitleInput}
            aiProposingLot={aiProposingLot}
            handleLotNumberInputChange={handleLotNumberInputChange}
            handleLotTitleInputChange={handleLotTitleInputChange}
            updateHistory={updateHistory}
            draggedIndex={draggedIndex}
            dragOverIndex={dragOverIndex}
            handleHistoryDragStart={handleHistoryDragStart}
            handleHistoryDragOver={handleHistoryDragOver}
            handleHistoryDragEnd={handleHistoryDragEnd}
            handleHistoryDrop={handleHistoryDrop}
            isGroupedByLot={isGroupedByLot}
            catalogs={catalogs}
            activeCatalogId={activeCatalogId}
            onSwitchCatalog={handleSwitchCatalog}
            onRenameCatalog={handleRenameCatalog}
            onDeleteCatalog={handleDeleteCatalog}
            createNewCatalog={createNewCatalog}
            updateMultipleItemsCatalogue={updateMultipleItemsCatalogue}
            onNavigate={setActiveTab}
            onLoadHistoryItem={(item) => {
              setAnalysisResult(item.report);
              setPreviewUrl(item.imageUrl);
              setSelectedFile(null);
              setSignatureFile(null);
              setSignaturePreview(item.signatureImageUrl || null);
              setDamageFile(null);
              setDamagePreview(item.damageImageUrl || null);
              setScaleFile(null);
              setScalePreview(item.scaleImageUrl || null);
              setCurrentHistoryItemId(item.id);
              setActiveTab("sandbox");
            }}
          />
        ) : activeTab === "admin" ? (
          <AdminPromptPanel 
            currentUser={currentUser}
            onMethodAdded={async () => {
              try {
                const res = await fetch("/api/appraisal-methods");
                if (res.ok) {
                  const data = await res.json();
                  if (Array.isArray(data)) {
                    setAppraisalMethods(data);
                  }
                }
              } catch (err) {
                console.error("Failed to refresh appraisal methods list:", err);
              }
            }}
          />
        ) : (
          <SettingsView
            currentUser={currentUser}
            userRole={currentUserRole}
            onLogout={handleLogout}
            catalogs={catalogs}
            setCatalogs={setCatalogs}
            activeCatalogId={activeCatalogId}
            setActiveCatalogId={setActiveCatalogId}
            setCatalogHistory={setCatalogHistory}
            onOpenAuthModal={() => {
              setIsSignUpMode(false);
              setShowAuthModal(true);
            }}
          />
        )}

      {/* USER AUTHENTICATION MODAL */}
      {showAuthModal && (
        <div className="fixed inset-0 bg-black/45 backdrop-blur-md z-50 flex items-center justify-center p-4">
          <div className="bg-white border border-rosebery-border rounded-sm max-w-sm w-full p-6 md:p-8 space-y-6 shadow-xl relative animate-fadeIn">
            <button
              onClick={() => {
                setShowAuthModal(false);
                setAuthError("");
                setAuthSuccess("");
                setAuthUsername("");
                setAuthPassword("");
                setAuthName("");
                setAuthRole("seller");
              }}
              className="absolute top-4 right-4 text-stone-400 hover:text-rosebery-primary transition-colors cursor-pointer"
            >
              <X className="w-5 h-5" />
            </button>

            <div className="border-b border-rosebery-border pb-3.5 text-center">
              <span className="text-[9px] font-mono text-rosebery-primary tracking-[0.2em] font-extrabold uppercase block mb-1">
                MEMBERSHIP ACCESS
              </span>
              <h3 className="text-xl font-serif text-rosebery-charcoal font-semibold">
                {isSignUpMode ? "Create Collector Account" : "Access Dealer Account"}
              </h3>
            </div>

            {authError && (
              <div className="p-3 bg-rose-50 border border-rose-200 text-rose-800 text-xs rounded-sm animate-fadeIn">
                {authError}
              </div>
            )}

            {authSuccess && (
              <div className="p-3 bg-emerald-50 border border-emerald-200 text-emerald-800 text-xs rounded-sm animate-fadeIn">
                {authSuccess}
              </div>
            )}

            <form onSubmit={handleAuthSubmit} className="space-y-4">
              {isSignUpMode && (
                <>
                  <div className="space-y-1.5 animate-fadeIn">
                    <label className="text-[10px] font-mono text-rosebery-primary font-semibold block">Full Name</label>
                    <input
                      type="text"
                      placeholder="Enter display name (e.g. Agathe)"
                      value={authName}
                      onChange={(e) => setAuthName(e.target.value)}
                      className="w-full bg-stone-50 border border-rosebery-border rounded-sm px-3 py-2 text-xs focus:outline-none focus:border-rosebery-primary focus:ring-1 focus:ring-rosebery-primary/25"
                    />
                  </div>
                  <div className="space-y-1.5 animate-fadeIn">
                    <label className="text-[10px] font-mono text-rosebery-primary font-semibold block">Role</label>
                    <select
                      value={authRole}
                      onChange={(e) => setAuthRole(e.target.value)}
                      className="w-full bg-stone-50 border border-rosebery-border rounded-sm px-3 py-2 text-xs focus:outline-none focus:border-rosebery-primary focus:ring-1 focus:ring-rosebery-primary/25 cursor-pointer font-sans"
                    >
                      <option value="seller">Seller (Default)</option>
                      <option value="buyer">Buyer</option>
                    </select>
                  </div>
                </>
              )}

              <div className="space-y-1.5">
                <label className="text-[10px] font-mono text-rosebery-primary font-semibold block">Username or Email</label>
                <input
                  type="text"
                  required
                  placeholder="Enter username or email address"
                  value={authUsername}
                  onChange={(e) => setAuthUsername(e.target.value)}
                  className="w-full bg-stone-50 border border-rosebery-border rounded-sm px-3 py-2 text-xs focus:outline-none focus:border-rosebery-primary focus:ring-1 focus:ring-rosebery-primary/25"
                />
              </div>

              <div className="space-y-1.5">
                <label className="text-[10px] font-mono text-rosebery-primary font-semibold block">Password</label>
                <input
                  type="password"
                  required
                  placeholder="Enter password"
                  value={authPassword}
                  onChange={(e) => setAuthPassword(e.target.value)}
                  className="w-full bg-stone-50 border border-rosebery-border rounded-sm px-3 py-2 text-xs focus:outline-none focus:border-rosebery-primary focus:ring-1 focus:ring-rosebery-primary/25"
                />
              </div>

              <button
                type="submit"
                disabled={authLoading}
                className="w-full bg-rosebery-primary hover:bg-rosebery-primary-hover disabled:bg-stone-300 text-white font-mono text-[11px] font-bold uppercase tracking-wider py-3 rounded-xs flex items-center justify-center gap-1.5 cursor-pointer transition-colors duration-200"
              >
                {authLoading ? <Loader2 className="w-4 h-4 animate-spin" /> : null}
                {isSignUpMode ? "Register Account" : "Secure Login"}
              </button>
            </form>

            <div className="text-center pt-2">
              <button
                type="button"
                onClick={() => {
                  setIsSignUpMode(!isSignUpMode);
                  setAuthError("");
                  setAuthSuccess("");
                }}
                className="text-xs text-rosebery-muted hover:text-rosebery-primary underline font-sans transition-colors cursor-pointer"
              >
                {isSignUpMode ? "Already have an account? Log In" : "Need an account? Sign Up"}
              </button>
            </div>
          </div>
        </div>
      )}

      {/* EMAIL SUMMARY FILE PREVIEW & DISPATCH DIALOG MODAL */}


      </main>
    </div>
  );
}
