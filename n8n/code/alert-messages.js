// Turns one FlightByte event into the messages this workflow can send.
// Edit the list and the threshold to change who hears about what.

// Change types a passenger hears about by email.
const EMAIL_CHANGES = [
  'flight.cancelled',
  'flight.diverted',
  'flight.reinstated',
  'route.changed',
  'departure.gate.changed',
  'departure.terminal.changed',
  'departure.scheduled.changed',
  'departure.estimated.changed',
  'delay.increased',
];
// Cancellations and diversions always go out by SMS,
// and so does an arrival delay of this many minutes or more.
const SMS_DELAY_MINUTES = 60;

const event = $('Event type').item.json.body;
const flight = event.flight;
// The row the form saved; empty when the flight was watched some other way.
const contact = { bookingRef: event.metadata?.bookingRef, ...$json };
// A time moves on the gate and the runway together; keep the gate one when both are there.
// A status change that comes with "cancelled", "departed" and the like says nothing more.
const all = event.changes ?? [];
const changes = all.filter(
  (change) =>
    !(change.path.endsWith('Runway') && all.some((other) => other.type === change.type && other.path.endsWith('Gate'))) &&
    !(change.type === 'status.changed' && all.some((other) => other.type.startsWith('flight.'))),
);

const dep = flight.departure;
const arr = flight.arrival;
const number = `${flight.carrier.iata}${flight.flightNumber}`;
const place = (endpoint) => endpoint.airport.city ?? endpoint.airport.iata;
const route = `${place(dep)} to ${place(arr)}`;
const day = DateTime.fromISO(flight.date).toFormat('d LLL');

// Webhook times are UTC; show them in the airport's own time zone.
const clock = (utc, endpoint) =>
  utc ? DateTime.fromISO(utc).setZone(endpoint.airport.timezone).toFormat('HH:mm') : 'unknown';
const best = (endpoint) => {
  const times = endpoint.times;
  return (times.actualGate ?? times.estimatedGate ?? times.scheduledGate)?.utc;
};

function describe(change) {
  const endpoint = change.path.startsWith('arrival') ? arr : dep;
  const side = endpoint === arr ? 'Arrival' : 'Departure';
  switch (change.type) {
    case 'flight.cancelled':
      return 'The flight is cancelled';
    case 'flight.diverted':
      return `The flight is diverted${flight.diverted ? ` to ${place(flight.diverted)}` : ''}`;
    case 'flight.reinstated':
      return 'The flight is back on after a cancellation';
    case 'delay.increased':
    case 'delay.decreased':
      return `Arrival delay is now ${change.to} minutes (was ${change.from})`;
    case 'departure.gate.changed':
    case 'departure.terminal.changed':
    case 'arrival.gate.changed':
    case 'arrival.terminal.changed':
      return `${side} ${change.type.split('.')[1]} is now ${change.to ?? 'not set'}${change.from ? ` (was ${change.from})` : ''}`;
    case 'arrival.baggage.changed':
      return `Baggage belt is ${change.to ?? 'not set'}`;
  }
  if (/\.(scheduled|estimated|actual)\.changed$/.test(change.type)) {
    const kind = `${change.type.split('.')[1]}${change.path.endsWith('Runway') ? ' runway' : ''}`;
    return `${side} time (${kind}) is now ${clock(change.to, endpoint)}${change.from ? `, was ${clock(change.from, endpoint)}` : ''}`;
  }
  return change.message;
}

const lines = changes.map((change) => `• ${describe(change)}`);
const has = (type) => changes.some((change) => change.type === type);
const delay = changes.find((change) => change.type === 'delay.increased' && change.to >= SMS_DELAY_MINUTES);

let headline = `${number} ${route}, ${day}: departs ${clock(best(dep), dep)}`;
if (dep.terminal) headline += `, terminal ${dep.terminal}`;
if (dep.gate) headline += `, gate ${dep.gate}`;
if (has('flight.cancelled')) headline = `${number} ${route} on ${day} is cancelled`;
else if (has('flight.diverted')) headline = `${number} ${route} on ${day} is diverted`;

return {
  json: {
    flight: number,
    bookingRef: contact.bookingRef ?? '',
    slackText: [`*${headline}*${contact.bookingRef ? ` (booking ${contact.bookingRef})` : ''}`, ...lines].join('\n'),
    sendEmail: Boolean(contact.email) && changes.some((change) => EMAIL_CHANGES.includes(change.type)),
    emailTo: contact.email ?? '',
    emailSubject: `Update on your flight ${number} to ${place(arr)}`,
    emailText: [
      contact.passengerName ? `Hi ${contact.passengerName},` : 'Hello,',
      '',
      `There is an update on your flight ${number} from ${route} on ${day}.`,
      '',
      ...lines,
      '',
      `${headline}.`,
      'All times are local to each airport.',
    ].join('\n'),
    sendSms: Boolean(contact.phone) && (has('flight.cancelled') || has('flight.diverted') || Boolean(delay)),
    smsTo: contact.phone ?? '',
    smsText: `${headline}.${delay ? ` Arrival delay is now ${delay.to} minutes.` : ''}`,
  },
};
