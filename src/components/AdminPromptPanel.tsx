import React, { useState, useEffect } from "react";
import { 
  Sparkles, 
  Settings, 
  AlertTriangle, 
  Save, 
  FileText, 
  CheckCircle2, 
  Info,
  Sliders,
  Terminal,
  Activity
} from "lucide-react";

interface AdminPromptPanelProps {
  currentUser: string | null;
  onMethodAdded?: () => void;
}

export default function AdminPromptPanel({ currentUser, onMethodAdded }: AdminPromptPanelProps) {
  // Config States
  const [defaultTemplates, setDefaultTemplates] = useState<{
    standard: string;
    simplified: string;
    strict: string;
  } | null>(null);

  const [selectedBase, setSelectedBase] = useState<"standard" | "simplified" | "strict">("standard");
  const [promptText, setPromptText] = useState("");
  
  // Custom Method fields
  const [methodName, setMethodName] = useState("");
  const [methodId, setMethodId] = useState("");
  const [description, setDescription] = useState("");
  const [modelName, setModelName] = useState("gemini-2.5-flash");
  const [temperature, setTemperature] = useState(0.15);
  const [imageQuality, setImageQuality] = useState<"original" | "medium" | "low">("original");
  const [includeAuxScans, setIncludeAuxScans] = useState(true);

  // Status/Loading States
  const [isLoading, setIsLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [success, setSuccess] = useState<string | null>(null);

  // Load default prompt templates from server on mount
  useEffect(() => {
    const loadDefaultPrompts = async () => {
      try {
        const res = await fetch("/api/admin/prompts", {
          headers: { "X-User-Header": currentUser || "" }
        });
        if (res.ok) {
          const data = await res.json();
          setDefaultTemplates(data);
          // Pre-populate with standard
          setPromptText(data.standard || "");
        } else {
          const errData = await res.json();
          setError(errData.error || "Failed to load default templates.");
        }
      } catch (err) {
        console.error("Failed to load prompt templates:", err);
        setError("Network error loading default templates.");
      }
    };
    if (currentUser) {
      loadDefaultPrompts();
    }
  }, [currentUser]);

  // Handle base template switch
  const handleBaseChange = (base: "standard" | "simplified" | "strict") => {
    setSelectedBase(base);
    if (defaultTemplates) {
      setPromptText(defaultTemplates[base] || "");
    }
  };

  // Auto-generate a unique slug/ID from the name
  const handleNameChange = (nameVal: string) => {
    setMethodName(nameVal);
    const slug = "custom-" + nameVal
      .toLowerCase()
      .trim()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "");
    setMethodId(slug);
  };

  const handleSave = async (e: React.FormEvent) => {
    e.preventDefault();
    setError(null);
    setSuccess(null);

    if (!methodId.startsWith("custom-")) {
      setError("Appraisal Method ID must start with 'custom-' to distinguish it from system defaults.");
      return;
    }

    if (promptText.trim().length === 0) {
      setError("Prompt template text cannot be empty.");
      return;
    }

    setIsLoading(true);
    try {
      const res = await fetch("/api/appraisal-methods", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "X-User-Header": currentUser || ""
        },
        body: JSON.stringify({
          id: methodId,
          name: methodName,
          description: description,
          modelName: modelName,
          temperature: temperature,
          promptKey: selectedBase,
          promptText: promptText,
          imageQuality: imageQuality,
          includeAuxiliaryScans: includeAuxScans,
          provider: modelName.startsWith("claude") ? "anthropic" : "gemini"
        })
      });

      const data = await res.json();
      if (!res.ok) {
        throw new Error(data.error || "Failed to save custom appraisal method.");
      }

      setSuccess(`Appraisal Method "${methodName}" successfully compiled and registered!`);
      
      // Clear or refresh parent list
      if (onMethodAdded) {
        onMethodAdded();
      }
    } catch (err: any) {
      setError(err.message || "An unexpected error occurred.");
    } finally {
      setIsLoading(false);
    }
  };

  return (
    <div className="space-y-8 animate-fadeIn max-w-5xl mx-auto pb-16">
      {/* Header section */}
      <div className="text-center space-y-2.5">
        <span className="inline-flex bg-rosebery-cream-bg border border-rosebery-border px-3.5 py-1.5 rounded-sm text-xs font-serif text-rosebery-primary font-medium tracking-wide italic">
          System Customization Dashboard
        </span>
        <h2 className="text-2xl md:text-3xl font-serif font-semibold text-rosebery-charcoal tracking-wide">
          Admin Prompt & Model Manager
        </h2>
        <p className="text-xs md:text-sm text-rosebery-muted max-w-xl mx-auto leading-relaxed">
          Create, edit, and fine-tune system appraisal prompts. Register customized models with configured hyperparameters to immediately deploy them as new evaluation criteria.
        </p>
      </div>

      {/* Warning Info box about prompt structure limitations */}
      <div className="bg-amber-50 border border-amber-200 text-amber-900 rounded-sm p-4 flex items-start gap-3 shadow-sm border-l-4 border-l-amber-500">
        <AlertTriangle className="w-5 h-5 text-amber-600 flex-shrink-0 mt-0.5" />
        <div className="text-xs space-y-1">
          <p className="font-bold font-serif">Critical Appraisal Prompt Guidelines</p>
          <p className="text-amber-800 leading-normal">
            The appraisal engine requests a strictly structured JSON response from the LLM. 
            <strong> You cannot modify the expected JSON output fields in the prompt.</strong> 
            However, you can alter the analytical guidelines, instructions, thresholds, and condition penalties, 
            or provide references and links to databases/watermark catalogs to guide the model's appraisal reasoning.
          </p>
        </div>
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-12 gap-8">
        {/* Left Side: Editor (Col span 7) */}
        <div className="lg:col-span-7 bg-white border border-rosebery-border rounded-sm p-6 shadow-gallery-soft space-y-5">
          <div className="flex items-center justify-between border-b border-rosebery-border pb-3.5">
            <div className="flex items-center gap-2">
              <Terminal className="w-4 h-4 text-rosebery-gold" />
              <h3 className="text-sm font-serif text-rosebery-charcoal font-semibold">
                Prompt Template Editor
              </h3>
            </div>
            {/* Quick Template Switcher */}
            <div className="flex border border-rosebery-border rounded-sm overflow-hidden text-[9px] font-mono shadow-xs bg-stone-50">
              {(["standard", "simplified", "strict"] as const).map((key) => (
                <button
                  key={key}
                  type="button"
                  onClick={() => handleBaseChange(key)}
                  className={`px-2 py-1.5 font-bold uppercase tracking-wider transition-colors cursor-pointer ${
                    selectedBase === key
                      ? "bg-rosebery-primary text-white"
                      : "text-rosebery-muted hover:text-rosebery-primary hover:bg-[#E8E2D7]/20"
                  }`}
                >
                  {key}
                </button>
              ))}
            </div>
          </div>

          <div className="space-y-1.5">
            <div className="flex justify-between items-center text-[10px] font-mono text-rosebery-muted">
              <span>Edit Instructions & Rules</span>
              <span>Available tags: <code className="bg-[#FAF9F6] border border-rosebery-border px-1 text-rosebery-primary font-bold">{"{currency}"}</code>, <code className="bg-[#FAF9F6] border border-rosebery-border px-1 text-rosebery-primary font-bold">{"{userNotes}"}</code></span>
            </div>
            <textarea
              value={promptText}
              onChange={(e) => setPromptText(e.target.value)}
              rows={22}
              className="w-full bg-[#FAF9F6] border border-rosebery-border rounded-sm p-3.5 text-xs font-mono text-stone-700 focus:outline-none focus:border-rosebery-primary focus:ring-1 focus:ring-rosebery-primary/25 leading-relaxed resize-y"
              placeholder="Paste or write prompt template here..."
            />
          </div>
        </div>

        {/* Right Side: Setup parameters (Col span 5) */}
        <div className="lg:col-span-5 space-y-6">
          {error && (
            <div className="p-3 bg-red-50 border border-red-200 text-red-800 text-xs rounded-sm flex items-center gap-2 animate-fadeIn shadow-sm">
              <AlertTriangle className="w-4 h-4 flex-shrink-0 text-red-600" />
              <span>{error}</span>
            </div>
          )}

          {success && (
            <div className="p-3 bg-green-50 border border-green-200 text-green-800 text-xs rounded-sm flex items-center gap-2 animate-fadeIn shadow-sm">
              <CheckCircle2 className="w-4 h-4 flex-shrink-0 text-green-600" />
              <span>{success}</span>
            </div>
          )}

          <form onSubmit={handleSave} className="bg-rosebery-card border border-rosebery-border rounded-sm p-6 shadow-gallery-soft space-y-5">
            <div className="border-b border-rosebery-border pb-3">
              <div className="flex items-center gap-2">
                <Sliders className="w-4 h-4 text-rosebery-gold" />
                <h3 className="text-sm font-serif text-rosebery-charcoal font-semibold">
                  Appraisal Method Parameters
                </h3>
              </div>
              <p className="text-[10px] text-rosebery-muted mt-0.5">
                Register model parameters and naming details.
              </p>
            </div>

            {/* Form Fields */}
            <div className="space-y-4">
              <div className="space-y-1.5">
                <label className="text-[10px] font-mono text-rosebery-primary font-bold uppercase tracking-wider block">
                  Method Name
                </label>
                <input
                  type="text"
                  required
                  placeholder="e.g. Gemini 2.5 Pro Custom"
                  value={methodName}
                  onChange={(e) => handleNameChange(e.target.value)}
                  className="w-full bg-white border border-rosebery-border rounded-sm px-3 py-2 text-xs focus:outline-none focus:border-rosebery-primary focus:ring-1 focus:ring-rosebery-primary/25"
                />
              </div>

              <div className="space-y-1.5">
                <div className="flex justify-between items-center">
                  <label className="text-[10px] font-mono text-rosebery-primary font-bold uppercase tracking-wider block">
                    Unique Method ID
                  </label>
                  <span className="text-[8px] font-mono text-rosebery-muted">Must start with 'custom-'</span>
                </div>
                <input
                  type="text"
                  required
                  placeholder="e.g. custom-gemini-pro-custom"
                  value={methodId}
                  onChange={(e) => setMethodId(e.target.value)}
                  className="w-full bg-white border border-rosebery-border rounded-sm px-3 py-2 text-xs focus:outline-none focus:border-rosebery-primary focus:ring-1 focus:ring-rosebery-primary/25 font-mono"
                />
              </div>

              <div className="space-y-1.5">
                <label className="text-[10px] font-mono text-rosebery-primary font-bold uppercase tracking-wider block">
                  Description
                </label>
                <input
                  type="text"
                  placeholder="e.g. Focused on reproduction alert and condition flags."
                  value={description}
                  onChange={(e) => setDescription(e.target.value)}
                  className="w-full bg-white border border-rosebery-border rounded-sm px-3 py-2 text-xs focus:outline-none focus:border-rosebery-primary focus:ring-1 focus:ring-rosebery-primary/25"
                />
              </div>

              <div className="grid grid-cols-2 gap-3.5">
                <div className="space-y-1.5">
                  <label className="text-[10px] font-mono text-rosebery-primary font-bold uppercase tracking-wider block">
                    Base model
                  </label>
                  <select
                    value={modelName}
                    onChange={(e) => setModelName(e.target.value)}
                    className="w-full bg-white border border-rosebery-border rounded-sm px-2.5 py-2 text-xs focus:outline-none focus:border-rosebery-primary focus:ring-1 focus:ring-rosebery-primary/25 cursor-pointer font-sans"
                  >
                    <option value="gemini-3stage">Gemini 3-Stage Pipeline</option>
                    <option value="claude-3stage">Claude 3-Stage Pipeline</option>
                    <option value="gemini-2.5-flash">Gemini 2.5 Flash</option>
                    <option value="gemini-2.5-pro">Gemini 2.5 Pro</option>
                    <option value="gemini-pro-latest">Gemini Pro Stable</option>
                    <option value="gemini-3.1-pro-preview">Gemini 3.1 Pro (Prev)</option>
                    <option value="claude-sonnet-4-6">Claude Sonnet 4.6</option>
                    <option value="claude-opus-4-8">Claude Opus 4.8</option>
                  </select>
                </div>

                <div className="space-y-1.5">
                  <label className="text-[10px] font-mono text-rosebery-primary font-bold uppercase tracking-wider block">
                    Image Quality
                  </label>
                  <select
                    value={imageQuality}
                    onChange={(e) => setImageQuality(e.target.value as any)}
                    className="w-full bg-white border border-rosebery-border rounded-sm px-2.5 py-2 text-xs focus:outline-none focus:border-rosebery-primary focus:ring-1 focus:ring-rosebery-primary/25 cursor-pointer font-sans"
                  >
                    <option value="original">Original resolution</option>
                    <option value="medium">Medium (1024px)</option>
                    <option value="low">Low (512px)</option>
                  </select>
                </div>
              </div>

              <div className="space-y-2 pt-1">
                <div className="flex justify-between items-center text-[10px] font-mono text-rosebery-primary font-bold uppercase tracking-wider">
                  <span>Temperature</span>
                  <span className="text-rosebery-primary font-bold bg-[#E8E2D7]/50 px-2 py-0.5 rounded-sm">{temperature}</span>
                </div>
                <input
                  type="range"
                  min="0"
                  max="1.0"
                  step="0.05"
                  value={temperature}
                  onChange={(e) => setTemperature(parseFloat(e.target.value))}
                  className="w-full accent-[#4C0B2A] cursor-pointer"
                />
              </div>

              <div className="flex items-center gap-2.5 pt-1.5 cursor-pointer">
                <input
                  type="checkbox"
                  id="includeAuxScans"
                  checked={includeAuxScans}
                  onChange={(e) => setIncludeAuxScans(e.target.checked)}
                  className="rounded border-rosebery-border text-rosebery-primary focus:ring-rosebery-primary w-4 h-4 cursor-pointer"
                />
                <label 
                  htmlFor="includeAuxScans" 
                  className="text-xs text-rosebery-charcoal font-semibold cursor-pointer font-serif select-none"
                >
                  Include auxiliary scans (Signature, Damage, Scale)
                </label>
              </div>
            </div>

            <button
              type="submit"
              disabled={isLoading}
              className="w-full bg-rosebery-primary hover:bg-rosebery-primary-hover disabled:bg-[#FAF9F6] text-white disabled:text-stone-400 font-mono text-[11px] font-bold uppercase tracking-wider py-3.5 rounded-xs flex items-center justify-center gap-1.5 cursor-pointer transition-colors duration-200 shadow-sm mt-3"
            >
              {isLoading ? (
                <Activity className="w-3.5 h-3.5 animate-spin" />
              ) : (
                <Save className="w-3.5 h-3.5" />
              )}
              Save & Deploy Method
            </button>
          </form>
        </div>
      </div>
    </div>
  );
}
