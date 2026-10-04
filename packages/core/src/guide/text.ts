export const TERMS_URL = 'https://github.com/IEISI-ORG/rir-mcp/blob/main/TERMS_OF_USE.md';

export const INSTRUCTIONS = `rir-mcp answers registry questions about IP addresses, prefixes, AS numbers, organisations and reverse DNS, using RDAP data from the five Regional Internet Registries (APNIC, ARIN, RIPE NCC, LACNIC, AFRINIC).
Tools:
- rdap_ip_lookup: who holds an address or prefix, and where to report abuse.
- rdap_asn_lookup: who holds an AS number.
- rdap_entity_lookup: an organisation or role handle seen in another answer.
- rdap_reverse_dns: the registered reverse-DNS delegation (nameservers) for an address.
- rdap_history: registration history and provenance (APNIC only); use at=YYYY-MM-DD for "who held X on that date".
Rules: one resource per call; no search, lists or bulk queries. Personal contact data is never returned. Answers are cached (current records for about an hour, history for up to 7 days) and may be served marked STALE when they cannot be refreshed (registry unreachable, or a rate limit reached); the "source" line gives each answer's age.
Use is subject to the rir-mcp Terms of Use (${TERMS_URL}): no marketing to, spamming or harassment of RIR members.`;

export const USAGE_GUIDE = `# rir-mcp usage guide

Ask one question about one resource at a time.

| Question | Tool | Arguments |
|---|---|---|
| Who holds 1.1.1.1? | rdap_ip_lookup | address: "1.1.1.1" |
| Where do I report abuse from 203.0.113.0/24? | rdap_ip_lookup | address: "203.0.113.0/24" |
| Who is AS4608? | rdap_asn_lookup | asn: "AS4608" |
| What is ORG-ARAD1-AP? | rdap_entity_lookup | handle: "ORG-ARAD1-AP" |
| What is IRT-APNICRANDNET-AU? | rdap_entity_lookup | handle: "IRT-APNICRANDNET-AU", rir: "apnic" |
| What are the reverse DNS servers for 1.1.1.1? | rdap_reverse_dns | address: "1.1.1.1" |
| What's the history of 1.1.1.1? | rdap_history | resource: "1.1.1.1" |
| Who held 1.1.1.1 on 2012-01-01? | rdap_history | resource: "1.1.1.1", at: "2012-01-01" |

Not available: searching by name, listing an organisation's resources, bulk lookups, personal contact details, routing (BGP) data.

Private, documentation and other special-purpose addresses and AS numbers are answered locally without contacting any registry.

Terms of Use: ${TERMS_URL}
`;
