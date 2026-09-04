import type { Database } from "../../shared/sqlite";
export declare const COMPARTMENT_LEASE_TTL_MS: number;
export declare const COMPARTMENT_LEASE_RENEWAL_MS: number;
export interface LeaseAcquired {
    sessionId: string;
    holderId: string;
    acquiredAt: number;
    expiresAt: number;
}
export declare function acquireCompartmentLease(db: Database, sessionId: string, holderId: string): LeaseAcquired | null;
export declare function renewCompartmentLease(db: Database, sessionId: string, holderId: string): boolean;
export declare function releaseCompartmentLease(db: Database, sessionId: string, holderId: string): void;
export declare function isCompartmentLeaseHeld(db: Database, sessionId: string, holderId: string): boolean;
//# sourceMappingURL=compartment-lease.d.ts.map