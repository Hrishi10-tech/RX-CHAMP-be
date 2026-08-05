-- Drop the redundant cached display-name column; it is now derived from
-- first_name + last_name in the application layer.
ALTER TABLE "users" DROP COLUMN "name";
