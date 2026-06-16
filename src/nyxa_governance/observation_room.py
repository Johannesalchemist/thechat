from __future__ import annotations

from dataclasses import dataclass, field
from enum import Enum
from typing import Any, Dict, List, Optional


class ClaimType(str, Enum):
    OBSERVATION = "observation"
    INFERENCE = "inference"
    HYPOTHESIS = "hypothesis"
    EVIDENCE = "evidence"
    DECISION = "decision"
    ACTION = "action"


class SignalState(str, Enum):
    RAW_SIGNAL = "RAW_SIGNAL"
    OBSERVED = "OBSERVED"
    HELD_IN_OBSERVATION_ROOM = "HELD_IN_OBSERVATION_ROOM"
    INVESTIGATION_TRIGGERED = "INVESTIGATION_TRIGGERED"
    UNDER_INVESTIGATION = "UNDER_INVESTIGATION"
    EVIDENCE_CANDIDATE = "EVIDENCE_CANDIDATE"
    EVIDENCE_RELEASED = "EVIDENCE_RELEASED"
    ACCEPTED_STATE = "ACCEPTED_STATE"
    ACTIONABLE_STATE = "ACTIONABLE_STATE"
    ARCHIVED = "ARCHIVED"
    REJECTED = "REJECTED"
    ROLLED_BACK = "ROLLED_BACK"


class Confidence(str, Enum):
    LOW = "low"
    MEDIUM = "medium"
    HIGH = "high"


class BayesianWeight(str, Enum):
    LOW = "low"
    MEDIUM = "medium"
    HIGH = "high"


class ValidationStatus(str, Enum):
    NOT_VALIDATED = "not_validated"
    PARTIALLY_VALIDATED = "partially_validated"
    VALIDATED = "validated"
    CONTRADICTED = "contradicted"


class AllowedAction(str, Enum):
    OBSERVE = "observe"
    INVESTIGATE = "investigate"
    DRAFT = "draft"
    PROPOSE = "propose"
    EXECUTE = "execute"


class BlastRadius(str, Enum):
    LOW = "low"
    MEDIUM = "medium"
    HIGH = "high"
    PRODUCTION = "production"


@dataclass(frozen=True)
class Provenance:
    source_type: str
    source_ref: str
    timestamp: str
    direct_observation: bool = False

    def is_complete(self) -> bool:
        return bool(self.source_type and self.source_ref and self.timestamp)


@dataclass(frozen=True)
class Valence:
    coherence: str = "unknown"
    risk: str = "low"
    momentum: str = "low"


@dataclass
class GovernanceClaim:
    claim: str
    claim_type: ClaimType
    provenance: Optional[Provenance]
    valence: Valence
    bayesian_weight: BayesianWeight
    confidence: Confidence
    validation_status: ValidationStatus
    allowed_action: AllowedAction
    blocked_action: str
    blast_radius: BlastRadius
    state: SignalState = SignalState.HELD_IN_OBSERVATION_ROOM
    assumptions: List[str] = field(default_factory=list)
    validation_notes: List[str] = field(default_factory=list)
    evidence_refs: List[str] = field(default_factory=list)

    def has_required_release_fields(self) -> bool:
        return (
            bool(self.claim)
            and self.provenance is not None
            and self.provenance.is_complete()
            and self.confidence in Confidence
            and self.validation_status in ValidationStatus
            and self.allowed_action in AllowedAction
            and self.blast_radius in BlastRadius
        )


class EvidenceReleaseError(ValueError):
    pass


class ObservationRoomPolicy:
    HIGH_RISK_RADII = {BlastRadius.HIGH, BlastRadius.PRODUCTION}

    @staticmethod
    def can_enter_observation_room(claim: GovernanceClaim) -> bool:
        return bool(claim.claim) and claim.state in {
            SignalState.RAW_SIGNAL,
            SignalState.OBSERVED,
            SignalState.HELD_IN_OBSERVATION_ROOM,
        }

    @staticmethod
    def should_trigger_investigation(claim: GovernanceClaim) -> bool:
        if claim.validation_status == ValidationStatus.CONTRADICTED:
            return True
        if claim.blast_radius in ObservationRoomPolicy.HIGH_RISK_RADII:
            return True
        if claim.valence.risk in {"medium", "high"}:
            return True
        if claim.bayesian_weight in {BayesianWeight.MEDIUM, BayesianWeight.HIGH}:
            return True
        if claim.confidence == Confidence.HIGH and claim.validation_status != ValidationStatus.VALIDATED:
            return True
        return False

    @staticmethod
    def can_release_to_evidence(claim: GovernanceClaim) -> bool:
        if not claim.has_required_release_fields():
            return False
        if claim.validation_status != ValidationStatus.VALIDATED:
            return False
        if claim.allowed_action == AllowedAction.EXECUTE and claim.blast_radius in ObservationRoomPolicy.HIGH_RISK_RADII:
            return False
        if claim.validation_status == ValidationStatus.CONTRADICTED:
            return False
        return True

    @staticmethod
    def release_to_evidence(claim: GovernanceClaim) -> GovernanceClaim:
        if not ObservationRoomPolicy.can_release_to_evidence(claim):
            raise EvidenceReleaseError(
                "Claim cannot be released to evidence without complete provenance, "
                "validated status, confidence discipline, allowed action, and controlled blast radius."
            )
        claim.state = SignalState.EVIDENCE_RELEASED
        claim.claim_type = ClaimType.EVIDENCE
        return claim

    @staticmethod
    def next_state(claim: GovernanceClaim) -> SignalState:
        if claim.validation_status == ValidationStatus.CONTRADICTED:
            return SignalState.REJECTED

        if ObservationRoomPolicy.can_release_to_evidence(claim):
            return SignalState.EVIDENCE_RELEASED

        if ObservationRoomPolicy.should_trigger_investigation(claim):
            return SignalState.INVESTIGATION_TRIGGERED

        return SignalState.HELD_IN_OBSERVATION_ROOM


def classify_claim(claim: GovernanceClaim) -> Dict[str, Any]:
    next_state = ObservationRoomPolicy.next_state(claim)

    return {
        "claim": claim.claim,
        "claim_type": claim.claim_type.value,
        "current_state": claim.state.value,
        "next_state": next_state.value,
        "provenance_complete": claim.provenance.is_complete() if claim.provenance else False,
        "confidence": claim.confidence.value,
        "bayesian_weight": claim.bayesian_weight.value,
        "validation_status": claim.validation_status.value,
        "allowed_action": claim.allowed_action.value,
        "blast_radius": claim.blast_radius.value,
        "investigation_triggered": next_state == SignalState.INVESTIGATION_TRIGGERED,
        "evidence_release_allowed": next_state == SignalState.EVIDENCE_RELEASED,
        "blocked_action": claim.blocked_action,
    }
