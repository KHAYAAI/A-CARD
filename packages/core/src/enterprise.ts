import { newId } from "./ids.js";
import { DomainError, NotFoundError } from "./errors.js";
import type { Currency } from "./money.js";

/**
 * Enterprise structure: departments with monthly budgets, and an org-wide
 * policy enforced on every authorization ahead of per-card rules.
 *
 * A personal account is simply an account holder with no departments and a
 * permissive default policy — the same code path serves both, so "enterprise"
 * is a capability of the platform, not a separate product.
 */

export type WorkspaceType = "personal" | "enterprise";

export interface Department {
  id: string;
  accountHolderId: string;
  name: string;
  /** Monthly spend cap in minor units of the org's primary currency. */
  monthlyBudget: number;
  lead?: string;
  createdAt: string;
}

export interface OrgPolicy {
  /** Merchant category codes declined org-wide, regardless of card rules. */
  blockedMerchantCategories: string[];
  /**
   * Org-wide approval threshold (minor units). Charges at/above this are
   * routed to human approval even if the card itself has no threshold.
   * Undefined = no org threshold.
   */
  approvalThreshold?: number;
}

export const DEFAULT_ORG_POLICY: OrgPolicy = { blockedMerchantCategories: [] };

export interface CreateDepartmentInput {
  accountHolderId: string;
  name: string;
  monthlyBudget: number;
  lead?: string;
}

export function validateDepartmentInput(input: CreateDepartmentInput): void {
  if (!input.name.trim()) throw new DomainError("invalid_department", "department name is required");
  if (!Number.isSafeInteger(input.monthlyBudget) || input.monthlyBudget <= 0) {
    throw new DomainError("invalid_department", "monthlyBudget must be a positive integer of minor units");
  }
}

/** In-memory department + policy store, serialized with the platform snapshot. */
export class EnterpriseService {
  private readonly departments = new Map<string, Department>();
  private readonly policies = new Map<string, OrgPolicy>();

  serialize(): { departments: Department[]; policies: Array<[string, OrgPolicy]> } {
    return { departments: [...this.departments.values()], policies: [...this.policies.entries()] };
  }

  static hydrate(data: { departments: Department[]; policies: Array<[string, OrgPolicy]> }): EnterpriseService {
    const service = new EnterpriseService();
    for (const d of data.departments ?? []) service.departments.set(d.id, d);
    for (const [holderId, policy] of data.policies ?? []) service.policies.set(holderId, policy);
    return service;
  }

  createDepartment(input: CreateDepartmentInput): Department {
    validateDepartmentInput(input);
    const department: Department = {
      id: newId("dept"),
      accountHolderId: input.accountHolderId,
      name: input.name.trim(),
      monthlyBudget: input.monthlyBudget,
      lead: input.lead,
      createdAt: new Date().toISOString(),
    };
    this.departments.set(department.id, department);
    return department;
  }

  getDepartment(id: string): Department {
    const d = this.departments.get(id);
    if (!d) throw new NotFoundError("department", id);
    return d;
  }

  findDepartment(id: string): Department | undefined {
    return this.departments.get(id);
  }

  listDepartments(accountHolderId: string): Department[] {
    return [...this.departments.values()]
      .filter((d) => d.accountHolderId === accountHolderId)
      .sort((a, b) => a.createdAt.localeCompare(b.createdAt));
  }

  updateDepartment(id: string, patch: { name?: string; monthlyBudget?: number; lead?: string }): Department {
    const d = this.getDepartment(id);
    if (patch.name !== undefined) d.name = patch.name.trim() || d.name;
    if (patch.monthlyBudget !== undefined) {
      if (!Number.isSafeInteger(patch.monthlyBudget) || patch.monthlyBudget <= 0) {
        throw new DomainError("invalid_department", "monthlyBudget must be a positive integer of minor units");
      }
      d.monthlyBudget = patch.monthlyBudget;
    }
    if (patch.lead !== undefined) d.lead = patch.lead;
    return d;
  }

  getPolicy(accountHolderId: string): OrgPolicy {
    return this.policies.get(accountHolderId) ?? { ...DEFAULT_ORG_POLICY, blockedMerchantCategories: [] };
  }

  setPolicy(accountHolderId: string, policy: OrgPolicy): OrgPolicy {
    if (policy.approvalThreshold !== undefined && (!Number.isSafeInteger(policy.approvalThreshold) || policy.approvalThreshold <= 0)) {
      throw new DomainError("invalid_policy", "approvalThreshold must be a positive integer of minor units");
    }
    const clean: OrgPolicy = {
      blockedMerchantCategories: [...new Set(policy.blockedMerchantCategories ?? [])],
      approvalThreshold: policy.approvalThreshold,
    };
    this.policies.set(accountHolderId, clean);
    return clean;
  }
}

/** A department's spend summary for a billing period. */
export interface DepartmentSpend {
  department: Department;
  /** Held + captured spend across the department's cards this month, minor units. */
  spentThisMonth: number;
  cardCount: number;
  currency: Currency;
}
