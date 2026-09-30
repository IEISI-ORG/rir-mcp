import type { McpServer } from '@modelcontextprotocol/server';
import * as z from 'zod/v4';
import { RIRS } from './rdap/rirs';
import { renderHistory } from './render/history';
import { renderAutnum, renderDomain, renderEntity, renderNetwork, renderSpecial } from './render/text';
import type { Answer, Meta } from './service/answer';
import type { RirService } from './service/service';

export const TOOL_NAMES = ['rdap_ip_lookup', 'rdap_asn_lookup', 'rdap_entity_lookup', 'rdap_reverse_dns', 'rdap_history'] as const;

const RIR = z.enum(RIRS);
const DATE = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'Use YYYY-MM-DD');
const OUTPUT = z.object({
  answer: z.enum(['record', 'special']),
  rir: z.string().optional(),
  cache: z.string().optional(),
  data: z.record(z.string(), z.unknown()),
});

interface ToolResult {
  [key: string]: unknown;
  content: Array<{ type: 'text'; text: string }>;
  structuredContent?: Record<string, unknown>;
  isError?: boolean;
}

function result<T extends object>(answer: Answer<T>, render: (record: T, meta: Meta) => string): ToolResult {
  if (answer.kind === 'error') return { content: [{ type: 'text', text: answer.message }], isError: true };
  if (answer.kind === 'special') {
    return {
      content: [{ type: 'text', text: renderSpecial(answer.query, answer.special) }],
      structuredContent: { answer: 'special', data: { query: answer.query, ...answer.special } },
    };
  }
  return {
    content: [{ type: 'text', text: render(answer.record, answer.meta) }],
    structuredContent: { answer: 'record', rir: answer.meta.rir, cache: answer.meta.cache, data: answer.record as unknown as Record<string, unknown> },
  };
}

/** Unexpected failures never leak internals to the model. */
async function safely(fn: () => Promise<ToolResult>): Promise<ToolResult> {
  try {
    return await fn();
  } catch {
    return { content: [{ type: 'text', text: 'Internal error while answering this question.' }], isError: true };
  }
}

const doc = (answers: string, input: string, examples: string, not: string): string =>
  `Answers: ${answers}\nInput forms: ${input}\nExample questions: ${examples}\nDoes not: ${not}`;

export function registerTools(server: McpServer, service: RirService): void {
  server.registerTool('rdap_ip_lookup', {
    title: 'IP address / prefix registration',
    description: doc(
      'who holds an IP address or prefix: registered range, name, country, status, holder, abuse contact and dates, from the authoritative RIR.',
      'one IPv4 or IPv6 address or CIDR, e.g. 1.1.1.1, 203.0.113.0/24, 2001:db8::/32.',
      '"Who holds 1.1.1.1?", "Where do I report abuse from 8.8.8.8?"',
      'search, list or bulk-query; return personal contact details; show routing (BGP) data.',
    ),
    inputSchema: z.object({ address: z.string().max(64).describe('One IPv4/IPv6 address or CIDR') }),
    outputSchema: OUTPUT,
  }, async ({ address }) => safely(async () => result(await service.ip(address), renderNetwork)));

  server.registerTool('rdap_asn_lookup', {
    title: 'AS number registration',
    description: doc(
      'who holds an Autonomous System number: name, country, holder, abuse contact and dates.',
      'AS4608, as4608 or 4608 (asdot 1.10 also accepted).',
      '"Who is AS4608?", "Who do I contact about AS15169?"',
      'show peers, prefixes announced or routing data; return personal contact details.',
    ),
    inputSchema: z.object({ asn: z.string().max(20).describe('AS number, e.g. AS4608') }),
    outputSchema: OUTPUT,
  }, async ({ asn }) => safely(async () => result(await service.asn(asn), renderAutnum)));

  server.registerTool('rdap_entity_lookup', {
    title: 'Organisation / role handle',
    description: doc(
      'details of an organisation or role (e.g. abuse team) handle seen in another answer: name, email, roles, dates.',
      'one handle such as ORG-ARAD1-AP; add rir when the handle has no RIR suffix (e.g. IRT-APNICRANDNET-AU with rir "apnic").',
      '"What is ORG-ARAD1-AP?"',
      'search by name; list an organisation\'s resources; disclose records of individual people.',
    ),
    inputSchema: z.object({ handle: z.string().max(64).describe('Registry handle'), rir: RIR.optional() }),
    outputSchema: OUTPUT,
  }, async ({ handle, rir }) => safely(async () => result(await service.entity(handle, rir), renderEntity)));

  server.registerTool('rdap_reverse_dns', {
    title: 'Reverse DNS delegation',
    description: doc(
      'the reverse-DNS zone registered for an address or prefix, its nameservers and whether it is DNSSEC-signed (registry view, not live DNS).',
      'one IPv4 or IPv6 address or prefix; the tool works out the in-addr.arpa / ip6.arpa zone.',
      '"What are the reverse DNS servers for 1.1.1.1?"',
      'query live DNS; check whether the nameservers actually answer.',
    ),
    inputSchema: z.object({ address: z.string().max(64).describe('One IPv4/IPv6 address or prefix') }),
    outputSchema: OUTPUT,
  }, async ({ address }) => safely(async () => result(await service.reverseDns(address), renderDomain)));

  server.registerTool('rdap_history', {
    title: 'Registration history (whowas) and provenance',
    description: doc(
      'how a resource\'s registration changed over time (created, withdrawn, renamed, holder changes), or who held it on a date. APNIC only.',
      'resource = an IP/CIDR, AS number, handle, or (with type "reverse_dns") an address; optional at=YYYY-MM-DD, since=YYYY-MM-DD, detail "summary" | "full".',
      '"What\'s the history of 1.1.1.1?", "Who held 1.1.1.1 on 2012-01-01?"',
      'return history for ARIN, RIPE NCC, LACNIC or AFRINIC resources (they do not publish it); return personal data.',
    ),
    inputSchema: z.object({
      resource: z.string().max(64),
      type: z.enum(['ip', 'asn', 'entity', 'reverse_dns']).optional(),
      rir: RIR.optional(),
      at: DATE.optional(),
      since: DATE.optional(),
      detail: z.enum(['summary', 'full']).optional(),
    }),
    outputSchema: OUTPUT,
  }, async ({ resource, type, rir, at, since, detail }) => safely(async () => result(
    await service.history({ resource, type, rir }),
    (rec, meta) => renderHistory(rec, meta, { detail: detail ?? 'summary', since, at }),
  )));
}
