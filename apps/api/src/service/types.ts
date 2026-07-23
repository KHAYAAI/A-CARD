import type {
  AccountHolder,
  ApprovalRequest,
  ApprovalStatus,
  AuthorizationDecision,
  AuthorizationRequest,
  Card,
  CardTransaction,
  CreateCardInput,
  Currency,
  Department,
  DepartmentSpend,
  LedgerTransaction,
  OrgPolicy,
  PlatformEvent,
  Role,
  SessionContext,
  SubscriptionTier,
  User,
  WorkspaceType,
} from "@acard/core";

export type PublicUser = Omit<User, "passwordHash">;

export interface RegisterResult {
  user: PublicUser;
  accountHolder: AccountHolder;
  sessionToken: string;
  context: SessionContext;
}

export interface MemberView {
  user: PublicUser;
  role: Role;
  createdAt: string;
}

/**
 * The async persistence-and-orchestration port the REST API talks to.
 *
 * Two implementations back it:
 *  - `InMemoryPlatformService` — wraps the synchronous in-memory `Platform`.
 *    Zero external dependencies; the sandbox and the single-instance
 *    snapshot-durability deployment both use it.
 *  - `PostgresPlatformService` — real row-level ledger tables with SQL balance
 *    aggregation and a per-wallet `SELECT ... FOR UPDATE` lock on the
 *    authorization hot path, so several API instances can share one database
 *    without racing the overspend guard.
 *
 * Keeping the API behind this single async interface means the two are truly
 * interchangeable: the exact same request handlers, tests, and MCP/CLI clients
 * run against either.
 */

export interface WalletBalance {
  available: number;
  posted: number;
  held: number;
  currency: Currency;
}

export type CreateCardParams = Omit<CreateCardInput, "walletAccountId" | "currency"> & {
  currency?: Currency;
};

export type IdempotencyLookup =
  | { hit: true; status: number; body: unknown }
  | { hit: false; conflict: boolean };

export interface PlatformService {
  // ---- account holders & auth ---------------------------------------------
  signup(input: { email: string; name: string; currency?: Currency; accountType?: WorkspaceType }): Promise<AccountHolder>;
  getAccountHolder(id: string): Promise<AccountHolder | undefined>;
  issueApiKey(accountHolderId: string, name: string): Promise<{ secret: string; id: string }>;
  authenticateApiKey(secret: string): Promise<AccountHolder | undefined>;
  setSubscriptionTier(accountHolderId: string, tier: SubscriptionTier): Promise<AccountHolder>;

  // ---- wallet (one per currency; ZAR + USD + any supported currency) -------
  /** Balance for a single currency (defaults to the holder's primary currency). */
  walletBalance(accountHolderId: string, currency?: Currency): Promise<WalletBalance>;
  /** Every currency wallet the holder holds, primary currency first. */
  walletBalances(accountHolderId: string): Promise<WalletBalance[]>;
  fundWallet(
    accountHolderId: string,
    amount: number,
    currency?: Currency,
    reference?: string,
  ): Promise<{ ledgerTransaction: LedgerTransaction; wallet: WalletBalance }>;

  // ---- cards ---------------------------------------------------------------
  createCard(input: CreateCardParams): Promise<Card>;
  listCards(accountHolderId: string): Promise<Card[]>;
  getCard(id: string): Promise<Card | undefined>;
  closeCard(id: string, reason?: string): Promise<Card>;

  // ---- transactions --------------------------------------------------------
  listTransactions(filter: { accountHolderId?: string; cardId?: string }): Promise<CardTransaction[]>;

  // ---- approvals -----------------------------------------------------------
  listApprovals(filter: { accountHolderId?: string; status?: ApprovalStatus }): Promise<ApprovalRequest[]>;
  getApproval(id: string): Promise<ApprovalRequest | undefined>;
  decideApproval(id: string, decision: "approved" | "denied", decidedBy: string): Promise<ApprovalRequest>;

  // ---- real-time authorization (the hot path) ------------------------------
  authorize(request: AuthorizationRequest): Promise<AuthorizationDecision>;
  capture(authorizationId: string, finalAmount?: number): Promise<CardTransaction>;
  reverse(authorizationId: string): Promise<CardTransaction>;

  // ---- idempotency ---------------------------------------------------------
  idempotencyGet(key: string, requestHash: string): Promise<IdempotencyLookup>;
  idempotencyPut(key: string, requestHash: string, status: number, body: unknown): Promise<void>;
  markEvent(eventId: string): Promise<boolean>;

  // ---- human auth & RBAC (dashboard) ---------------------------------------
  /** Register a user, create their org (account holder + wallet), make them owner, open a session. */
  registerAccount(input: {
    email: string;
    name: string;
    password: string;
    currency?: Currency;
    accountType?: WorkspaceType;
  }): Promise<RegisterResult>;
  login(input: { email: string; password: string; accountHolderId?: string }): Promise<{ sessionToken: string; context: SessionContext }>;
  resolveSession(token: string): Promise<SessionContext | undefined>;
  logout(token: string): Promise<void>;
  /** Add (or re-role) a member of an org. Creates the user if the email is new. */
  addMember(input: { accountHolderId: string; email: string; name?: string; password?: string; role: Role }): Promise<MemberView>;
  listMembers(accountHolderId: string): Promise<MemberView[]>;

  // ---- enterprise: departments, policy, audit ------------------------------
  createDepartment(input: { accountHolderId: string; name: string; monthlyBudget: number; lead?: string }): Promise<Department>;
  updateDepartment(id: string, patch: { name?: string; monthlyBudget?: number; lead?: string }): Promise<Department>;
  listDepartments(accountHolderId: string): Promise<Department[]>;
  listDepartmentSpend(accountHolderId: string): Promise<DepartmentSpend[]>;
  getPolicy(accountHolderId: string): Promise<OrgPolicy>;
  setPolicy(accountHolderId: string, policy: OrgPolicy): Promise<OrgPolicy>;

  // ---- in-process event fanout (Slack notifications) -----------------------
  onEvent(listener: (event: PlatformEvent) => void): void;

  // ---- lifecycle -----------------------------------------------------------
  close(): Promise<void>;
}
