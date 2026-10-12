/**
 * Registry of the legal documents a user can be asked to accept.
 *
 * The PDFs themselves are static files served by the frontend
 * (`public/docs/*.pdf`); the backend owns only their identity and version,
 * since that is what a consent record has to name. `url` is the frontend path
 * the user opened, stored here so the two stay in step.
 *
 * Publishing a new version: upload the new PDF, then bump `version` and
 * `effectiveFrom` here. Nothing else changes — existing consents keep pointing
 * at the version that was accepted, and GET /legal/consents starts reporting
 * the document as pending again, so the frontend can ask for a fresh tick.
 */
export const LEGAL_DOCUMENT_CODES = ['oferta', 'policy', 'payment'] as const;
export type LegalDocumentCode = (typeof LEGAL_DOCUMENT_CODES)[number];

export interface LegalDocument {
  code: LegalDocumentCode;
  version: string;
  title: string;
  /** Path on the frontend where the document is published. */
  url: string;
  /** Date this version took effect (ISO date, no time). */
  effectiveFrom: string;
}

export const LEGAL_DOCUMENTS: Record<LegalDocumentCode, LegalDocument> = {
  oferta: {
    code: 'oferta',
    version: '1.0',
    title: 'Публичная оферта',
    url: '/docs/oferta_quicksell.pdf',
    effectiveFrom: '2026-09-20',
  },
  policy: {
    code: 'policy',
    version: '1.0',
    title: 'Политика конфиденциальности',
    url: '/docs/policy_quicksell.pdf',
    effectiveFrom: '2026-09-20',
  },
  payment: {
    code: 'payment',
    version: '1.0',
    title: 'Процедура оплаты',
    url: '/docs/payment_quicksell.pdf',
    effectiveFrom: '2026-09-20',
  },
};

/** Where a checkbox is ticked. Each context requires its own set of documents. */
export const CONSENT_CONTEXTS = ['registration', 'subscription'] as const;
export type ConsentContext = (typeof CONSENT_CONTEXTS)[number];

/**
 * Documents that must be accepted in each context — mirrors the checkbox
 * wording on the frontend (`RegistrationConsentText` / `SubscriptionConsentText`).
 * One tick covers several documents, so one acceptance writes several rows.
 */
export const REQUIRED_DOCUMENTS: Record<ConsentContext, LegalDocumentCode[]> = {
  registration: ['oferta', 'policy'],
  subscription: ['oferta', 'payment'],
};

export function requiredDocuments(context: ConsentContext): LegalDocument[] {
  return REQUIRED_DOCUMENTS[context].map((code) => LEGAL_DOCUMENTS[code]);
}

export function allDocuments(): LegalDocument[] {
  return LEGAL_DOCUMENT_CODES.map((code) => LEGAL_DOCUMENTS[code]);
}
