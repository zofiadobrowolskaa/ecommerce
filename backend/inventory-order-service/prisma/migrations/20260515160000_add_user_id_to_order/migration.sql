-- additive migration: enables per-user order history
-- nullable so legacy rows stay valid; new orders fill it from the checkout body
ALTER TABLE "Order" ADD COLUMN "userId" TEXT;

-- compound index supports "list user X orders newest-first" without a scan
CREATE INDEX "Order_userId_createdAt_idx" ON "Order"("userId", "createdAt");
