/**
 * Preserve Stage 2a's evidence for a test run.
 *
 * The pipeline does not keep it. `runStage2aTriage` gets an `EvidenceAgentOutput` from the
 * model, hands it to `runEvidenceTree`, and returns only the assembled `TriageResult` —
 * which is a legacy-shaped summary. The cells the agent actually filled, and the cells the
 * deterministic tree actually read, are both dropped. That is fine in production (nothing
 * downstream needs them) and useless when you are trying to work out why a lot came out
 * the way it did: on A0793/148 the stored result showed `T6 conflict` with no record of
 * WHICH titles conflicted.
 *
 * Everything below the raw agent output is recomputed, not re-requested. `evidenceToTwoPassInput`
 * and `classifyTwoPass` are pure (~8.5µs for the whole tree), so replaying them over the
 * captured output reproduces exactly what the live run evaluated — no second API call, and
 * no risk of the record disagreeing with the run it describes.
 *
 * The most useful part is usually the difference between the two layers: `agentCells` is
 * what the LLM claimed, `treeInput` is what the tree read after code-built sources replaced
 * it (D and D_t from Stage 1d, A_t from Stage 1c). `overriddenByCode` names those explicitly
 * so a cell the agent filled and the code discarded is visible rather than inferred.
 */
import {
  evidenceToTwoPassInput,
  type EvidenceAgentOutput,
} from "../../src/appraisal/stage2a_evidence";
import { classifyTwoPass } from "../../src/appraisal/two_pass_attribution";
import {
  FourStageAppraiser,
  getAppraiserFromConfig,
  type AppraisalMethod,
  type AppraisalMethodConfig,
  type AckgLoopEvent,
} from "../../src/appraisal/appraiser";
import type { GoogleGenAI } from "@google/genai";
import type { Stage1dResult, AppraiserInputResult } from "../../src/types";

export interface EvidenceRecord {
  note: string;
  /** The cells exactly as the Stage 2a agent filled them, before any code override. */
  agentCells: EvidenceAgentOutput | null;
  /** The cells the deterministic tree actually read (code-built sources applied). */
  treeInput: ReturnType<typeof evidenceToTwoPassInput> | null;
  /** Verdicts + the full rule trace, including the per-vote pass-2 lines. */
  treeResult: ReturnType<typeof classifyTwoPass> | null;
  /** Cells where code replaced what the agent said, and with what. */
  overriddenByCode: Record<string, { agentSaid: unknown; codeUsed: unknown; why: string }>;
  /**
   * The ACKG tool loop, round by round: what the agent reasoned, what it asked the graph,
   * and what came back. This is usually the first thing you want when a verdict looks
   * wrong — on A0793/148 it showed one query establishing the artist and none establishing
   * the work, which the verdict alone could never have told you.
   */
  ackgRounds: AckgLoopEvent[];
}

const EMPTY: EvidenceRecord = {
  note: "Stage 2a evidence agent did not run (or its output was not captured).",
  agentCells: null,
  treeInput: null,
  treeResult: null,
  overriddenByCode: {},
  ackgRounds: [],
};

export function buildEvidenceRecord(
  agentCells: EvidenceAgentOutput | null,
  stage1d?: Stage1dResult | null,
  appraiserInput?: AppraiserInputResult | null,
  veaHaltRecommended = false,
  ackgRounds: AckgLoopEvent[] = [],
): EvidenceRecord {
  if (!agentCells) return { ...EMPTY, ackgRounds };

  const treeInput = evidenceToTwoPassInput(agentCells, veaHaltRecommended, stage1d, appraiserInput);
  const treeResult = classifyTwoPass(treeInput);

  const overriddenByCode: EvidenceRecord["overriddenByCode"] = {};

  // A_t — Stage 1c owns what counts as a title; the agent's cell is reported, not voted.
  const claimed = appraiserInput?.claimedAttribution?.title?.trim() || "";
  const agentTitle = agentCells.workEvidence?.appraiserTitle?.trim() || "";
  if (appraiserInput && agentTitle !== claimed) {
    overriddenByCode.titleAppraiser = {
      agentSaid: agentTitle || null,
      codeUsed: claimed || null,
      why: "Stage 1c's claimedAttribution.title is authoritative for the A_t vote; deciding what is a title rather than an inscription is Stage 1c's job.",
    };
  }

  // D / D_t are built from Stage 1d in code — the agent never sees Stage 1d at all.
  if (stage1d?.bestMatchArtist || stage1d?.bestMatchConceptualWorkTitle) {
    overriddenByCode.embeddingSources = {
      agentSaid: null,
      codeUsed: {
        artist: stage1d.bestMatchArtist ?? null,
        workTitle: stage1d.bestMatchConceptualWorkTitle ?? null,
        matchConfidence: stage1d.matchConfidence ?? null,
      },
      why: "D and D_t are built in code from Stage 1d; the Stage 2a prompt never carries Stage 1d, so the agent could not have reported them.",
    };
  }

  return {
    note:
      "agentCells = what the Stage 2a agent reported. treeInput = what the deterministic tree read " +
      "after code-built sources were applied. treeResult was recomputed from treeInput by replaying " +
      "the pure classifier, so it matches the live run exactly. ackgRounds is the tool loop as it " +
      "happened, with reasoning untruncated (the console log truncates it at 400 chars).",
    agentCells,
    treeInput,
    treeResult,
    overriddenByCode,
    ackgRounds,
  };
}


/**
 * An appraiser that keeps a copy of the Stage 2a cells, for harnesses that do not already
 * subclass. Only the 4-stage path has an evidence agent to capture; anything else is
 * returned unchanged with `getAgentCells()` reporting null, so a 3-stage or single-call
 * config still runs rather than erroring on a capability it does not have.
 */
export function appraiserWithEvidenceCapture(
  config: AppraisalMethodConfig,
  ai?: GoogleGenAI,
): {
  appraiser: AppraisalMethod;
  getAgentCells: () => EvidenceAgentOutput | null;
  getAckgRounds: () => AckgLoopEvent[];
} {
  if (!config.stage2aModel) {
    return { appraiser: getAppraiserFromConfig(config, ai), getAgentCells: () => null, getAckgRounds: () => [] };
  }

  class CapturingAppraiser extends FourStageAppraiser {
    public agentCells: EvidenceAgentOutput | null = null;
    public ackgRounds: AckgLoopEvent[] = [];
    protected onAckgLoopEvent(e: AckgLoopEvent): void {
      this.ackgRounds.push(e);
      super.onAckgLoopEvent(e); // keep the live log unchanged
    }
    protected async callClaudeWithAckgTool(
      modelName: string,
      systemInstruction: string,
      userText: string,
      maxTokens = 8192,
      finalTool: { name: string; description: string; schema: any },
      opts: { extraTools?: any[]; maxRounds?: number } = {},
    ): Promise<any> {
      const out = await super.callClaudeWithAckgTool(modelName, systemInstruction, userText, maxTokens, finalTool, opts);
      if (finalTool?.name === "report_attribution_evidence" && out?.artistEvidence) {
        this.agentCells = JSON.parse(JSON.stringify(out)) as EvidenceAgentOutput;
      }
      return out;
    }
  }

  const appraiser = new CapturingAppraiser(config, ai);
  return {
    appraiser,
    getAgentCells: () => appraiser.agentCells,
    getAckgRounds: () => appraiser.ackgRounds,
  };
}
