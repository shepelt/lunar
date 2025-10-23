local typedefs = require "kong.db.schema.typedefs"

return {
  name = "lunar-gateway",
  fields = {
    { consumer = typedefs.no_consumer },
    { protocols = typedefs.protocols_http },
    { config = {
        type = "record",
        fields = {
          { backend_url = { type = "string", required = true }, },
        },
      },
    },
  },
}
