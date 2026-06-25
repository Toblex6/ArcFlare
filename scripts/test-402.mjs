const res = await fetch("https://arcflare-gateway.onrender.com/api/nano/pay/agent-lookup?scaAddress=0x7a8214dad7630a7a39054e0121acdbc7a65821c9", {
  method: "POST",
  headers: { "Content-Type": "application/json" },
  body: "{}"
});
const data = await res.json();
console.log(JSON.stringify(data, null, 2));