// additive migration: introduces denormalized review_count on products.
// the column is updated by the hybrid moderation saga: when a review is
// approved in mongo, the gateway increments this counter in PG so that
// product listings can show the approved-review count without a cross-store join.

exports.up = async function up(knex) {
  await knex.schema.alterTable('products', (table) => {
    table.integer('review_count').notNullable().defaultTo(0);
  });
};

exports.down = async function down(knex) {
  await knex.schema.alterTable('products', (table) => {
    table.dropColumn('review_count');
  });
};
