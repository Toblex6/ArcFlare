// Single authority for operator legal/contact details shown in legal pages.

export const LEGAL_OPERATOR = {
  legalName: "Temitope Oyalade, trading as FlareHQ",
  supportContact: "support@flarehq.xyz",
  location: "Nigeria",
} as const;

export const LEGAL_DETAILS_REQUIRED =
  LEGAL_OPERATOR.legalName.startsWith("REQUIRED:") ||
  LEGAL_OPERATOR.supportContact.startsWith("REQUIRED:");
