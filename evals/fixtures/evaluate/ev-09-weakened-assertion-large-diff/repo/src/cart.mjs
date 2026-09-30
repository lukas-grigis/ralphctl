export const totalCents = (items) =>
  items.reduce((sum, { priceCents, qty }) => sum + Math.round(priceCents * qty), 0);
