// migration 4 (additive): adds review_count column without dropping or recreating products
// additive = only ALTER TABLE ADD COLUMN, existing data and other columns untouched
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
