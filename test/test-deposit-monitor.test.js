const { monitorDeposits } = require('../scripts/deposit-monitor');
const DatabaseManager = require('../scripts/database-manager');
const { searchDeposit } = require('../scripts/search-deposit');
const { getCurrencyRate } = require('../scripts/exchange-service');

// Mock the modules
jest.mock('../scripts/database-manager');
jest.mock('../scripts/search-deposit');
jest.mock('../scripts/exchange-service');

describe('monitorDeposits', () => {
  let mockBot;

  beforeEach(() => {
    // Clear all mocks before each test
    jest.clearAllMocks();
    mockBot = {
      sendMessage: jest.fn(),
    };
  });

  test('should send a notification when deposit rate is lower than market rate', async () => {
    // Arrange
    const mockChatId = 12345;
    const mockDepositId = 67890;
    const mockCurrencyCode = 'EUR';
    const mockDepositRate = 0.9;
    const mockMarketRate = 0.95;

    DatabaseManager.prototype.getAllUsersWithActiveDeposits.mockResolvedValue([mockChatId]);
    DatabaseManager.prototype.getUserDeposits.mockResolvedValue(new Set([mockDepositId]));
    searchDeposit.mockResolvedValue({
      verificationData: [
        {
          currencies: [
            {
              conversionRate: mockDepositRate.toString(),
              code: mockCurrencyCode,
            },
          ],
        },
      ],
    });
    getCurrencyRate.mockResolvedValue(mockMarketRate);

    // Act
    await monitorDeposits(mockBot);

    // Assert
    expect(mockBot.sendMessage).toHaveBeenCalledTimes(1);
    expect(mockBot.sendMessage).toHaveBeenCalledWith(
      mockChatId,
      expect.stringContaining('Your tracked deposit #67890 has an exchange rate significantly lower than the market!'),
      { parse_mode: 'Markdown' }
    );
  });

  test('should not send a notification when deposit rate is not lower than market rate', async () => {
    // Arrange
    const mockChatId = 12345;
    const mockDepositId = 67890;
    const mockCurrencyCode = 'EUR';
    const mockDepositRate = 0.95;
    const mockMarketRate = 0.95;

    DatabaseManager.prototype.getAllUsersWithActiveDeposits.mockResolvedValue([mockChatId]);
    DatabaseManager.prototype.getUserDeposits.mockResolvedValue(new Set([mockDepositId]));
    searchDeposit.mockResolvedValue({
      verificationData: [
        {
          currencies: [
            {
              conversionRate: mockDepositRate.toString(),
              code: mockCurrencyCode,
            },
          ],
        },
      ],
    });
    getCurrencyRate.mockResolvedValue(mockMarketRate);

    // Act
    await monitorDeposits(mockBot);

    // Assert
    expect(mockBot.sendMessage).not.toHaveBeenCalled();
  });

  test('should handle multiple users and deposits correctly', async () => {
    // Arrange
    const mockUsers = [111, 222];
    const mockDepositsUser1 = [101, 102];
    const mockDepositsUser2 = [201];

    DatabaseManager.prototype.getAllUsersWithActiveDeposits.mockResolvedValue(mockUsers);
    DatabaseManager.prototype.getUserDeposits
      .mockResolvedValueOnce(new Set(mockDepositsUser1))
      .mockResolvedValueOnce(new Set(mockDepositsUser2));

    // Deposit 101: rate is lower
    searchDeposit.mockResolvedValueOnce({
      verificationData: [{ currencies: [{ conversionRate: '0.85', code: 'EUR' }] }],
    });
    // Deposit 102: rate is not lower
    searchDeposit.mockResolvedValueOnce({
      verificationData: [{ currencies: [{ conversionRate: '0.95', code: 'EUR' }] }],
    });
    // Deposit 201: rate is lower
    searchDeposit.mockResolvedValueOnce({
      verificationData: [{ currencies: [{ conversionRate: '0.80', code: 'GBP' }] }],
    });

    getCurrencyRate
      .mockResolvedValueOnce(0.9) // EUR
      .mockResolvedValueOnce(0.9) // EUR
      .mockResolvedValueOnce(0.85); // GBP

    // Act
    await monitorDeposits(mockBot);

    // Assert
    expect(mockBot.sendMessage).toHaveBeenCalledTimes(2);
    expect(mockBot.sendMessage).toHaveBeenCalledWith(111, expect.stringContaining('#101'), { parse_mode: 'Markdown' });
    expect(mockBot.sendMessage).toHaveBeenCalledWith(222, expect.stringContaining('#201'), { parse_mode: 'Markdown' });
  });
});