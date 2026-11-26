import { describe, expect, it } from 'vitest'
import { acceptedTicketUrl } from './cloud-console-link'

describe('acceptedTicketUrl', () => {
  const allowed = ['https://console.coto.app', 'https://login.coto.app']

  it('opens a ticket URL only on an allowed origin, without credentials, over http(s)', () => {
    const ticket = 'https://console.coto.app/console/ticket?t=abc'
    expect(acceptedTicketUrl(ticket, allowed)).toBe(ticket)
    expect(acceptedTicketUrl('https://console.coto.app.evil.test/console', allowed)).toBeNull()
    expect(acceptedTicketUrl('https://evil.test/?u=https://console.coto.app', allowed)).toBeNull()
    expect(acceptedTicketUrl('https://user:pw@console.coto.app/console', allowed)).toBeNull()
    expect(acceptedTicketUrl('http://console.coto.app/console', allowed)).toBeNull()
    expect(acceptedTicketUrl('javascript:alert(1)', allowed)).toBeNull()
    expect(acceptedTicketUrl('file:///etc/passwd', allowed)).toBeNull()
    expect(acceptedTicketUrl({ url: ticket }, allowed)).toBeNull()
    expect(acceptedTicketUrl('not a url', allowed)).toBeNull()
  })
})
