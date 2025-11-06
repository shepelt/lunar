local typedefs = require "kong.db.schema.typedefs"

return {
  name = "noosphere-router",
  fields = {
    { consumer = typedefs.no_consumer },
    { protocols = typedefs.protocols_http },
    { config = {
        type = "record",
        fields = {
          { backend_url = { type = "string", required = true }, },
          { enable_routing = { type = "boolean", default = false }, },
        },
      },
    },
  },
}
