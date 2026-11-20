-- RX Vision 3.6: one counter per person that ends credentials minted before it moved
-- (access tokens, socket tickets, enrolment tokens). Additive: everyone starts at 0,
-- which is also what a token without the claim counts as, so nothing in the field
-- stops working until the first sign-out, block, role or manager change for its person.
ALTER TABLE "users" ADD COLUMN "auth_epoch" INTEGER DEFAULT 0 NOT NULL;
