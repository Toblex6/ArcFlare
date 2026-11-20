// Single authority for operator legal/contact details shown in legal pages.
//
// REQUIRED before launch: set the operator's actual legal name and support
// contact. The placeholders are intentionally explicit; do not invent or infer
// a company name. Location is known from the owner specification.

export const LEGAL_OPERATOR = {
  legalName: "REQUIRED: SET OPERATOR LEGAL NAME",
  supportContact: "REQUIRED: SET SUPPORT CONTACT",
  location: "Lagos, Nigeria",
} as const;

export const LEGAL_DETAILS_REQUIRED =
  LEGAL_OPERATOR.legalName.startsWith("REQUIRED:") ||
  LEGAL_OPERATOR.supportContact.startsWith("REQUIRED:");
