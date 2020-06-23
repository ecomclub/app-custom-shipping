'use strict'

module.exports = appSdk => {
  return (req, res) => {
    // body was already pre-validated on @/bin/web.js
    // treat module request body
    const { params, application } = req.body
    // app configured options
    const config = Object.assign({}, application.data, application.hidden_data)

    // start mounting response body
    // https://apx-mods.e-com.plus/api/v1/calculate_shipping/response_schema.json?store_id=100
    const response = {
      shipping_services: []
    }
    let shippingRules
    if (Array.isArray(config.shipping_rules) && config.shipping_rules.length) {
      shippingRules = config.shipping_rules
    } else {
      // anything to do without shipping rules
      res.send(response)
      return
    }

    const destinationZip = params.to ? params.to.zip.replace(/\D/g, '') : ''
    const originZip = params.from ? params.from.zip.replace(/\D/g, '')
      : config.zip ? config.zip.replace(/\D/g, '') : ''

    const checkZipCode = rule => {
      // validate rule zip range
      if (destinationZip && rule.zip_range) {
        const { min, max } = rule.zip_range
        return Boolean((!min || destinationZip >= min) && (!max || destinationZip <= max))
      }
      return true
    }

    // search for configured free shipping rule
    for (let i = 0; i < shippingRules.length; i++) {
      const rule = shippingRules[i]
      if (
        checkZipCode(rule) &&
        rule.total_price === 0 &&
        !rule.disable_free_shipping_from &&
        !(rule.excedent_weight_cost > 0) &&
        !(rule.amount_tax > 0)
      ) {
        if (!rule.min_amount) {
          response.free_shipping_from_value = 0
          break
        } else if (!(response.free_shipping_from_value <= rule.min_amount)) {
          response.free_shipping_from_value = rule.min_amount
        }
      }
    }

    // params object follows calculate shipping request schema:
    // https://apx-mods.e-com.plus/api/v1/calculate_shipping/schema.json?store_id=100
    if (!params.to) {
      // respond only with free shipping option
      res.send(response)
      return
    }

    if (!originZip) {
      // must have configured origin zip code to continue
      return res.status(400).send({
        error: 'CALCULATE_ERR',
        message: 'Zip code is unset on app hidden data (merchant must configure the app)'
      })
    }

    // calculate weight and pkg value from items list
    let amount = params.subtotal || 0
    if (params.items) {
      let finalWeight = 0
      params.items.forEach(({ price, quantity, dimensions, weight }) => {
        let physicalWeight = 0
        let cubicWeight = 1
        if (!params.subtotal) {
          amount += price * quantity
        }

        // sum physical weight
        if (weight && weight.value) {
          switch (weight.unit) {
            case 'kg':
              physicalWeight = weight.value
              break
            case 'g':
              physicalWeight = weight.value / 1000
              break
            case 'mg':
              physicalWeight = weight.value / 1000000
          }
        }

        // sum total items dimensions to calculate cubic weight
        if (dimensions) {
          const sumDimensions = {}
          for (const side in dimensions) {
            const dimension = dimensions[side]
            if (dimension && dimension.value) {
              let dimensionValue
              switch (dimension.unit) {
                case 'cm':
                  dimensionValue = dimension.value
                  break
                case 'm':
                  dimensionValue = dimension.value * 100
                  break
                case 'mm':
                  dimensionValue = dimension.value / 10
              }
              // add/sum current side to final dimensions object
              if (dimensionValue) {
                sumDimensions[side] = sumDimensions[side]
                  ? sumDimensions[side] + dimensionValue
                  : dimensionValue
              }
            }
          }

          // calculate cubic weight
          // https://suporte.boxloja.pro/article/82-correios-calculo-frete
          // (C x L x A) / 6.000
          for (const side in sumDimensions) {
            if (sumDimensions[side]) {
              cubicWeight *= sumDimensions[side]
            }
          }
          if (cubicWeight > 1) {
            cubicWeight /= 6000
          }
        }
        finalWeight += (quantity * (physicalWeight > cubicWeight ? physicalWeight : cubicWeight))
      })

      // start filtering shipping rules
      const validShippingRules = shippingRules.filter(rule => {
        if (typeof rule === 'object' && rule) {
          return (!params.service_code || params.service_code === rule.service_code) &&
            checkZipCode(rule) &&
            (!rule.min_amount || amount >= rule.min_amount) &&
            (!rule.max_cubic_weight || rule.excedent_weight_cost > 0 || finalWeight <= rule.max_cubic_weight)
        }
        return false
      })

      if (validShippingRules.length) {
        // group by service code selecting lower price
        const shippingRulesByCode = validShippingRules.reduce((shippingRulesByCode, rule) => {
          if (typeof rule.total_price !== 'number') {
            rule.total_price = 0
          }
          if (typeof rule.price !== 'number') {
            rule.price = rule.total_price
          }
          if (rule.excedent_weight_cost > 0 && finalWeight > rule.max_cubic_weight) {
            rule.total_price += (rule.excedent_weight_cost * (finalWeight - rule.max_cubic_weight))
          }
          if (typeof rule.amount_tax === 'number' && !isNaN(rule.amount_tax)) {
            rule.total_price += (rule.amount_tax * amount / 100)
          }
          const serviceCode = rule.service_code
          const currentShippingRule = shippingRulesByCode[serviceCode]
          if (!currentShippingRule || currentShippingRule.total_price > rule.total_price) {
            shippingRulesByCode[serviceCode] = rule
          }
          return shippingRulesByCode
        }, {})

        // parse final shipping rules object to shipping services array
        for (const serviceCode in shippingRulesByCode) {
          const rule = shippingRulesByCode[serviceCode]
          if (rule) {
            // delete filter properties from rule object
            delete rule.service_code
            delete rule.zip_range
            delete rule.min_amount
            delete rule.max_cubic_weight
            delete rule.excedent_weight_cost
            delete rule.amount_tax
            // also try to find corresponding service object from config
            let service
            if (Array.isArray(config.services)) {
              service = config.services.find(service => service.service_code === serviceCode)
            }

            response.shipping_services.push({
              label: serviceCode,
              // label, service_code, carrier (and maybe more) from service object
              ...service,
              shipping_line: {
                from: {
                  ...params.from,
                  zip: originZip
                },
                to: params.to,
                delivery_time: 20,
                price: 0,
                total_price: 0,
                // total_price, delivery_time (and maybe more) from rule object
                ...rule
              }
            })
          }
        }
      }
    }

    // expecting to have response with shipping services here
    res.send(response)
  }
}
