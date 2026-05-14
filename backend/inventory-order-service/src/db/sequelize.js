const { Sequelize, DataTypes } = require('sequelize');

// init sequelize connection (singleton)
const sequelize = new Sequelize(process.env.DATABASE_URL || 'postgres://user:password@postgres:5432/ecommerce_db', {
  logging: false
});

// cart model definition with explicit model-level validators
const Cart = sequelize.define('Cart', {
  userId: {
    type: DataTypes.STRING,
    allowNull: false,
    validate: {
      // built-in validator: rejects empty strings (allowNull only blocks null)
      notEmpty: { msg: 'userId cannot be empty' },
      // length constraint to prevent abuse
      len: { args: [1, 100], msg: 'userId length must be 1-100 characters' }
    }
  },
  status: {
    type: DataTypes.ENUM('OPEN', 'CLOSED'),
    defaultValue: 'OPEN',
    validate: {
      // explicit whitelist on top of ENUM constraint
      isIn: { args: [['OPEN', 'CLOSED']], msg: 'status must be OPEN or CLOSED' }
    }
  },
  totalPrice: {
    type: DataTypes.DECIMAL(10, 2),
    defaultValue: 0,
    validate: {
      // financial integrity: total cannot be negative
      min: { args: [0], msg: 'totalPrice cannot be negative' }
    }
  }
}, {
  // domain hooks: business rules executed automatically on every persist
  hooks: {
    beforeSave: (cart) => {
      // safety clamp: never allow negative totals to reach the database
      if (cart.totalPrice < 0) cart.totalPrice = 0;
    }
  }
});

// cart lines with explicit model-level validation
const CartLine = sequelize.define('CartLine', {
  productId: {
    type: DataTypes.INTEGER,
    allowNull: false,
    validate: {
      isInt: { msg: 'productId must be an integer' },
      min: { args: [1], msg: 'productId must be positive' }
    }
  },
  quantity: {
    type: DataTypes.INTEGER,
    allowNull: false,
    validate: {
      // domain rule: cannot order zero or negative quantity
      min: { args: [1], msg: 'quantity must be at least 1' }
    }
  },
  priceAtEntry: {
    type: DataTypes.DECIMAL(10, 2),
    allowNull: false,
    validate: {
      isDecimal: { msg: 'priceAtEntry must be a decimal' },
      // financial rule: snapshot price cannot be negative
      min: { args: [0], msg: 'priceAtEntry cannot be negative' }
    }
  }
});

// 1:N relation between cart and lines, used by eager loading (include)
Cart.hasMany(CartLine);
CartLine.belongsTo(Cart);

// domain hook: audit-log every cart line modification (useful for telemetry / debugging)
CartLine.addHook('afterSave', (line) => {
  // fires on both insert and update; produces a deterministic audit trail in service logs
  console.log(`[domain_hook] cart_line_saved cart=${line.CartId} product=${line.productId} qty=${line.quantity}`);
});

module.exports = { sequelize, Cart, CartLine };