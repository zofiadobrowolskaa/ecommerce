-- adds totalAmount column required for checkout
-- safe for existing rows due to default value
ALTER TABLE "Order" ADD COLUMN "totalAmount" DECIMAL(10,2) NOT NULL DEFAULT 0;

-- speeds up queries filtering by order status
CREATE INDEX "Order_status_idx" ON "Order"("status");