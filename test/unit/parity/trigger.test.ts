import axios from 'axios'
import type { Logger } from 'winston'
import { triggerParityCheck } from '../../../src/parity/trigger'

jest.mock('axios')
const mockedAxios = axios as jest.Mocked<typeof axios>

const logger = {
  info: jest.fn(),
  warn: jest.fn(),
  error: jest.fn(),
} as unknown as Logger

beforeEach(() => jest.clearAllMocks())

describe('triggerParityCheck', () => {
  it('POSTs to /parity with the version and token header (trailing slash trimmed)', async () => {
    mockedAxios.post.mockResolvedValue({ status: 200 })
    await triggerParityCheck('http://host:8080/', 'tok', '3.2.0', logger)
    expect(mockedAxios.post).toHaveBeenCalledWith(
      'http://host:8080/parity',
      { version: '3.2.0' },
      expect.objectContaining({
        headers: { 'x-cloud-scheduler-token': 'tok' },
      })
    )
  })

  it('treats a client timeout (ECONNABORTED) as success — the worker keeps running', async () => {
    mockedAxios.isAxiosError.mockReturnValue(true)
    mockedAxios.post.mockRejectedValue({ code: 'ECONNABORTED' })
    await expect(
      triggerParityCheck('http://h', 't', '1.0.0', logger)
    ).resolves.toBeUndefined()
    expect(logger.info).toHaveBeenCalled()
    expect(logger.warn).not.toHaveBeenCalled()
  })

  it('warns (never throws) on a real dispatch failure', async () => {
    mockedAxios.isAxiosError.mockReturnValue(false)
    mockedAxios.post.mockRejectedValue(new Error('connection refused'))
    await expect(
      triggerParityCheck('http://h', 't', '1.0.0', logger)
    ).resolves.toBeUndefined()
    expect(logger.warn).toHaveBeenCalled()
  })

  it('omits the auth header when no token is configured', async () => {
    mockedAxios.post.mockResolvedValue({ status: 200 })
    await triggerParityCheck('http://h', undefined, '1.0.0', logger)
    expect(mockedAxios.post).toHaveBeenCalledWith(
      'http://h/parity',
      { version: '1.0.0' },
      expect.objectContaining({ headers: {} })
    )
  })
})
