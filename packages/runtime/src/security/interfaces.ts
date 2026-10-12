import type {
  BrowserAction,
  HumanAnswer,
  HumanRequest,
  PermissionRequest,
  Policy,
  RiskLevel,
} from '@browser-os/protocol';

export interface RiskResult {
  risk: RiskLevel;
  reasons: string[];
}

/** action-router §3 step E. Replaced by the real classifier in Phase 9. */
export interface RiskClassifier {
  classify(
    action: BrowserAction,
    element: { role: string; name: string } | null,
    url: string,
    policy: Policy,
  ): RiskResult;
}

export interface PermissionGate {
  decide(risk: RiskResult, policy: Policy, origin: string): 'allow' | 'confirm' | 'deny';
  /** Pauses until answered; reject maps to PERMISSION_DENIED in the router. */
  requestConfirmation(request: PermissionRequest): Promise<'approve' | 'reject'>;
}

export type HumanPauseRequest = {
  sessionId: string;
  taskId: string | null;
  reason: HumanRequest['reason'];
  message: string;
  candidates?: HumanRequest['candidates'];
  /**
   * Observation the candidates were rendered from (action-router §5.3.1). A `ref`
   * answer must echo it back so a stale pick can be rejected. P7-04.
   */
  observationId?: string;
};

/** Pauses the run and resumes it with a human answer (or an abort). */
export interface HumanGate {
  pause(request: HumanPauseRequest): Promise<HumanAnswer>;
}
