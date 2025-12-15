const express = require('express')
const app = express()
const port = process.env.PORT || 5000;

app.get('/', (req, res) => {
  res.send('Welcome to AssetVerse Server')
})

app.listen(port, () => {
  console.log(`AssetVerse server is running on port ${port}`)
})
