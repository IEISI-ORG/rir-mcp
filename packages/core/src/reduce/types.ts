import type { Rir } from '../rdap/rirs';

export interface Contact {
  readonly handle: string;
  readonly name?: string;
  readonly email?: string;
}

/** A contact that exists but is a person: never disclosed. */
export interface Personal {
  readonly personal: true;
}

export type Party = Contact | Personal;

export function isPersonal(p: Party | undefined): p is Personal {
  return p !== undefined && 'personal' in p;
}

export interface ReduceCtx {
  readonly rir: Rir;
}

interface Registered {
  readonly rir: Rir;
  readonly handle: string;
  readonly name?: string;
  readonly country?: string;
  readonly status: readonly string[];
  readonly holder?: Party;
  readonly abuse?: Party;
  readonly tech?: Party;
  readonly admin?: Party;
  readonly registered?: string;
  readonly changed?: string;
}

export interface NetworkRecord extends Registered {
  readonly type: 'network';
  readonly prefixes: readonly string[];
  readonly allocationType?: string;
}

export interface AutnumRecord extends Registered {
  readonly type: 'autnum';
  readonly asnStart?: number;
  readonly asnEnd?: number;
}

export interface EntityRecord {
  readonly type: 'entity';
  readonly rir: Rir;
  readonly handle: string;
  readonly kind: 'org' | 'group';
  readonly name?: string;
  readonly email?: string;
  readonly roles: readonly string[];
  readonly registered?: string;
  readonly changed?: string;
}

export interface PersonalEntity {
  readonly type: 'personal-entity';
  readonly rir: Rir;
}

export interface DomainRecord {
  readonly type: 'domain';
  readonly rir: Rir;
  readonly zone: string;
  readonly nameservers: readonly string[];
  readonly signed: boolean;
  readonly registered?: string;
  readonly changed?: string;
}
