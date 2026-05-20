const { Sequelize, DataTypes } = require('sequelize');

// sequelize instance - one connection shared across the app
const sequelize = new Sequelize(process.env.DATABASE_URL || 'postgres://user:password@postgres:5432/ecommerce_db', {
  logging: false // disable sql query logging in the console
});

const Cart = sequelize.define('Cart', {
  userId: {
    type: DataTypes.STRING,
    allowNull: false,
    validate: {
      notEmpty: { msg: 'userId cannot be empty' },
      len: { args: [1, 100], msg: 'userId length must be 1-100 characters' }
    }
  },
  status: {
    type: DataTypes.ENUM('OPEN', 'CLOSED'),
    defaultValue: 'OPEN',
    validate: {
      isIn: { args: [['OPEN', 'CLOSED']], msg: 'status must be OPEN or CLOSED' }
    }
  },
  totalPrice: {
    type: DataTypes.DECIMAL(10, 2),
    defaultValue: 0,
    validate: {
      min: { args: [0], msg: 'totalPrice cannot be negative' }
    }
  }
}, {
  hooks: {
    // domain hook on Cart: beforeValidate fires before validators run,
    // prevents validation errors by safely resetting negative totals to 0
    beforeValidate: (cart) => {
      if (cart.totalPrice < 0) cart.totalPrice = 0;
    }
  }
});

const CartLine = sequelize.define('CartLine', {
  productId: {
    type: DataTypes.INTEGER,
    allowNull: false,
    validate: {
      isInt: { msg: 'productId must be an integer' },
      min: { args: [1], msg: 'productId must be positive' }
    }
  },
  variantSku: {
    type: DataTypes.STRING,
    allowNull: true,  // null = no specific variant chosen, checkout picks default
    validate: {
      len: { args: [0, 255], msg: 'variantSku too long' }
    }
  },
  quantity: {
    type: DataTypes.INTEGER,
    allowNull: false,
    validate: {
      min: { args: [1], msg: 'quantity must be at least 1' }
    }
  },
  priceAtEntry: {
    type: DataTypes.DECIMAL(10, 2),
    allowNull: false,
    validate: {
      isDecimal: { msg: 'priceAtEntry must be a decimal' },
      min: { args: [0], msg: 'priceAtEntry cannot be negative' }
    }
  }
});

Cart.hasMany(CartLine);
CartLine.belongsTo(Cart);

// domain hook on CartLine: afterSave fires after every insert or update.
// used as an audit trail - logs which cart and product were touched
CartLine.addHook('afterSave', (line) => {
  console.log(`[domain_hook] cart_line_saved cart=${line.CartId} product=${line.productId} qty=${line.quantity}`);
});

module.exports = { sequelize, Cart, CartLine };
