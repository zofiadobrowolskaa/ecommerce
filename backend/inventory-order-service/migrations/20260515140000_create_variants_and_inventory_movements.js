// additive schema: sku lives on variants; movements audit stock changes

exports.up = async function up(knex) {
  await knex.schema.createTable('variants', (table) => {
    table.increments('id').primary();
    table
      .integer('product_id')
      .unsigned() // id cannot be negative
      .notNullable()
      .references('id')
      .inTable('products')
      .onDelete('CASCADE'); // delete variants automatically when product is removed
    table.string('sku', 255).notNullable().unique();
    table.decimal('price', 10, 2).notNullable();
    table.integer('stock').notNullable().defaultTo(0);
    table.string('label', 255).nullable();
    table.index(['product_id']);
  });

  await knex.schema.createTable('inventory_movements', (table) => {
    table.increments('id').primary();
    table.string('sku', 255).notNullable();
    table.integer('quantity_delta').notNullable();
    table.string('reason', 64).notNullable();
    table.integer('order_id').nullable();
    table.timestamp('created_at').defaultTo(knex.fn.now());
    table.index(['sku']);
    table.index(['order_id']);
  });

  // data migration
  const products = await knex('products').select('id', 'sku', 'price', 'stock');
  if (products.length > 0) {
    await knex('variants').insert(
      products.map((p) => ({
        product_id: p.id,
        sku: p.sku,
        price: p.price,
        stock: p.stock
      }))
    );
  }
};

exports.down = async function down(knex) {
  await knex.schema.dropTableIfExists('inventory_movements');
  await knex.schema.dropTableIfExists('variants');
};
