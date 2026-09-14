import { describe, expect, it } from "vitest";
import { canMoveMoney, ComplianceService, effectiveStatus } from "../src/index.js";

function approved(service: ComplianceService, subjectId = "ah_1") {
  const record = service.open("account_holder", subjectId);
  service.attachSession(record.id, { providerSessionId: `sess_${subjectId}`, providerWorkflowId: "wf_kyc" });
  return service.recordProviderDecision(record.id, { status: "approved", amlRisk: "clear" });
}

describe("compliance records", () => {
  it("opening twice for the same subject returns the same record", () => {
    const service = new ComplianceService();
    const first = service.open("account_holder", "ah_1");
    const second = service.open("account_holder", "ah_1");
    expect(second.id).toBe(first.id);
    expect(service.list()).toHaveLength(1);
  });

  it("account holders and merchants are separate subjects even with the same id", () => {
    const service = new ComplianceService();
    const person = service.open("account_holder", "x_1");
    const business = service.open("merchant", "x_1");
    expect(business.id).not.toBe(person.id);
    expect(service.list({ subject: "merchant" })).toHaveLength(1);
  });

  it("attaching a session moves the record to pending and is resolvable by session id", () => {
    const service = new ComplianceService();
    const record = service.open("account_holder", "ah_1");
    const attached = service.attachSession(record.id, {
      providerSessionId: "sess_abc",
      providerWorkflowId: "wf_kyc",
      verificationUrl: "https://verify.didit.me/s/abc",
    });
    expect(attached.providerDecision).toBe("pending");
    expect(service.findByProviderSession("sess_abc")?.id).toBe(record.id);
  });

  it("refuses to rebind a record to a different provider session", () => {
    const service = new ComplianceService();
    const record = service.open("account_holder", "ah_1");
    service.attachSession(record.id, { providerSessionId: "sess_1", providerWorkflowId: "wf" });
    expect(() => service.attachSession(record.id, { providerSessionId: "sess_2", providerWorkflowId: "wf" })).toThrow(
      /already bound/,
    );
  });

  it("a replayed webhook decision does not duplicate history", () => {
    const service = new ComplianceService();
    const record = approved(service);
    const before = record.history.length;
    const again = service.recordProviderDecision(record.id, { status: "approved", amlRisk: "clear" });
    expect(again.history).toHaveLength(before);
  });

  it("approval with a clear screen can move money", () => {
    const service = new ComplianceService();
    expect(canMoveMoney(approved(service))).toBe(true);
  });

  it("no record at all cannot move money", () => {
    expect(canMoveMoney(undefined)).toBe(false);
  });

  it("a sanctions hit blocks money even when identity is approved", () => {
    const service = new ComplianceService();
    const record = approved(service);
    const hit = service.recordProviderDecision(record.id, { status: "approved", amlRisk: "hit", reasons: ["OFAC SDN"] });
    expect(effectiveStatus(hit)).toBe("approved");
    expect(canMoveMoney(hit)).toBe(false);
  });

  it("an attributed override can clear a false-positive hit", () => {
    const service = new ComplianceService();
    const record = approved(service);
    service.recordProviderDecision(record.id, { status: "approved", amlRisk: "hit" });
    const cleared = service.override(record.id, {
      status: "approved",
      decidedBy: "compliance@a-card.cc",
      reason: "common-name false positive, DOB and nationality both differ",
    });
    expect(canMoveMoney(cleared)).toBe(true);
    expect(cleared.providerDecision).toBe("approved");
    expect(cleared.amlRisk).toBe("hit");
    expect(cleared.override?.decidedBy).toBe("compliance@a-card.cc");
  });

  it("an override can also decline someone the provider approved", () => {
    const service = new ComplianceService();
    const record = approved(service);
    const declined = service.override(record.id, {
      status: "declined",
      decidedBy: "compliance@a-card.cc",
      reason: "document appears altered on manual inspection",
    });
    expect(effectiveStatus(declined)).toBe("declined");
    expect(canMoveMoney(declined)).toBe(false);
    // The provider's own decision is preserved, not overwritten.
    expect(declined.providerDecision).toBe("approved");
  });

  it("an override must name a reviewer and a reason", () => {
    const service = new ComplianceService();
    const record = approved(service);
    expect(() => service.override(record.id, { status: "approved", decidedBy: "", reason: "x" })).toThrow(/reviewer/);
    expect(() => service.override(record.id, { status: "approved", decidedBy: "a@b.c", reason: "" })).toThrow(/why/);
  });

  it("the review queue holds anything a human still has to look at, oldest first", () => {
    const service = new ComplianceService();
    const clean = approved(service, "ah_clean");
    const review = service.open("account_holder", "ah_review");
    service.attachSession(review.id, { providerSessionId: "s_r", providerWorkflowId: "wf" });
    service.recordProviderDecision(review.id, { status: "in_review" });
    const match = service.open("merchant", "mch_1");
    service.attachSession(match.id, { providerSessionId: "s_m", providerWorkflowId: "wf" });
    service.recordProviderDecision(match.id, { status: "approved", amlRisk: "possible_match" });

    const queue = service.pendingReview();
    expect(queue.map((r) => r.subjectId)).toEqual(["ah_review", "mch_1"]);
    expect(queue.map((r) => r.id)).not.toContain(clean.id);

    // Once a human decides, it leaves the queue.
    service.override(match.id, { status: "approved", decidedBy: "ops@a-card.cc", reason: "not the same entity" });
    expect(service.pendingReview().map((r) => r.subjectId)).toEqual(["ah_review"]);
  });

  it("survives a snapshot round trip, including session and subject lookups", () => {
    const service = new ComplianceService();
    const record = approved(service);
    const restored = ComplianceService.hydrate(JSON.parse(JSON.stringify(service.serialize())));
    expect(restored.find("account_holder", "ah_1")?.id).toBe(record.id);
    expect(restored.findByProviderSession("sess_ah_1")?.id).toBe(record.id);
    expect(canMoveMoney(restored.get(record.id))).toBe(true);
  });

  it("hydrates a snapshot taken before compliance existed", () => {
    expect(ComplianceService.hydrate({} as { records: [] }).list()).toHaveLength(0);
  });
});
