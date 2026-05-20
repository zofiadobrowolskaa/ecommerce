// migration 2 (additive): adds categories table and links products to it via fk
exports.up = function(knex) {
  return knex.schema
    .createTable('categories', table => {
      table.increments('id').primary();
      table.string('name').notNullable();
    })
    .alterTable('products', table => {
      // additive: adds category_id column without touching existing rows
      table.integer('category_id').references('id').inTable('categories');
    });
};

exports.down = function(knex) {
  return knex.schema.alterTable('products', table => {
    table.dropColumn('category_id');
  }).dropTable('categories');
};
