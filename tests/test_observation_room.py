import pytest

from src.nyxa_governance.observation_room import (
    AllowedAction,
    BayesianWeight,
    BlastRadius,
    ClaimType,
    Confidence,
    EvidenceReleaseError,
    GovernanceClaim,
    ObservationRoomPolicy,
    Provenance,
    SignalState,
    Valence,
    ValidationStatus,
    classify_claim,
)


def make_claim(**overrides):
    base = {
        "claim": "The auth middleware may be causing the 500 error.",
        "claim_type": ClaimType.INFERENCE,
        "provenance": Provenance(
            source_type="log",
            source_ref="server.log:500-error",
            timestamp="2026-05-30T15:00:00+02:00",
            direct_observation=True,
        ),
        "valence": Valence(
            coherence="destabilizing",
            risk="medium",
            momentum="medium",
        ),
        "bayesian_weight": BayesianWeight.MEDIUM,
        "confidence": Confidence.MEDIUM,
        "validation_status": ValidationStatus.NOT_VALIDATED,
        "allowed_action": AllowedAction.INVESTIGATE,
        "blocked_action": "execute rollback without stack trace validation",
        "blast_radius": BlastRadius.MEDIUM,
        "state": SignalState.HELD_IN_OBSERVATION_ROOM,
    }
    base.update(overrides)
    return GovernanceClaim(**base)


def test_unvalidated_inference_stays_out_of_evidence():
    claim = make_claim(validation_status=ValidationStatus.NOT_VALIDATED)

    assert not ObservationRoomPolicy.can_release_to_evidence(claim)

    with pytest.raises(EvidenceReleaseError):
        ObservationRoomPolicy.release_to_evidence(claim)


def test_missing_provenance_blocks_evidence_release():
    claim = make_claim(
        provenance=None,
        validation_status=ValidationStatus.VALIDATED,
    )

    assert not ObservationRoomPolicy.can_release_to_evidence(claim)

    with pytest.raises(EvidenceReleaseError):
        ObservationRoomPolicy.release_to_evidence(claim)


def test_validated_low_risk_claim_can_release_to_evidence():
    claim = make_claim(
        validation_status=ValidationStatus.VALIDATED,
        allowed_action=AllowedAction.PROPOSE,
        blast_radius=BlastRadius.LOW,
    )

    released = ObservationRoomPolicy.release_to_evidence(claim)

    assert released.state == SignalState.EVIDENCE_RELEASED
    assert released.claim_type == ClaimType.EVIDENCE


def test_high_risk_execute_is_blocked_even_when_validated():
    claim = make_claim(
        validation_status=ValidationStatus.VALIDATED,
        allowed_action=AllowedAction.EXECUTE,
        blast_radius=BlastRadius.HIGH,
    )

    assert not ObservationRoomPolicy.can_release_to_evidence(claim)

    with pytest.raises(EvidenceReleaseError):
        ObservationRoomPolicy.release_to_evidence(claim)


def test_contradicted_claim_is_rejected():
    claim = make_claim(validation_status=ValidationStatus.CONTRADICTED)

    assert ObservationRoomPolicy.next_state(claim) == SignalState.REJECTED


def test_high_blast_radius_triggers_investigation():
    claim = make_claim(
        validation_status=ValidationStatus.NOT_VALIDATED,
        blast_radius=BlastRadius.PRODUCTION,
    )

    assert ObservationRoomPolicy.should_trigger_investigation(claim)
    assert ObservationRoomPolicy.next_state(claim) == SignalState.INVESTIGATION_TRIGGERED


def test_high_confidence_without_validation_triggers_investigation():
    claim = make_claim(
        confidence=Confidence.HIGH,
        validation_status=ValidationStatus.NOT_VALIDATED,
    )

    assert ObservationRoomPolicy.should_trigger_investigation(claim)


def test_low_weight_low_risk_signal_remains_held():
    claim = make_claim(
        valence=Valence(coherence="unknown", risk="low", momentum="low"),
        bayesian_weight=BayesianWeight.LOW,
        confidence=Confidence.LOW,
        validation_status=ValidationStatus.NOT_VALIDATED,
        blast_radius=BlastRadius.LOW,
    )

    assert ObservationRoomPolicy.next_state(claim) == SignalState.HELD_IN_OBSERVATION_ROOM


def test_classify_claim_returns_governance_snapshot():
    claim = make_claim()

    snapshot = classify_claim(claim)

    assert snapshot["claim_type"] == "inference"
    assert snapshot["provenance_complete"] is True
    assert snapshot["validation_status"] == "not_validated"
    assert snapshot["evidence_release_allowed"] is False
    assert snapshot["investigation_triggered"] is True


def test_inference_without_provenance_is_not_governable_as_evidence():
    claim = make_claim(
        provenance=None,
        validation_status=ValidationStatus.VALIDATED,
        confidence=Confidence.HIGH,
    )

    snapshot = classify_claim(claim)

    assert snapshot["provenance_complete"] is False
    assert snapshot["evidence_release_allowed"] is False
