import { Controller, Get, Post, Put, Delete, Param, Body } from '@nestjs/common';
import { MeetingsService } from './meetings.service';
import { Meeting } from './entities/meeting.entity';

@Controller('meetings')
export class MeetingsController {
  constructor(private readonly meetingsService: MeetingsService) {}

  @Get()
  async findAll(): Promise<Meeting[]> {
    return await this.meetingsService.findAll();
  }

  @Get(':id')
  async findOne(@Param('id') id: string): Promise<Meeting | null> {
    return await this.meetingsService.findOne(id);
  }

  @Post()
  async create(@Body() body: Partial<Meeting>): Promise<Meeting> {
    return await this.meetingsService.create(body);
  }

  @Put(':id')
  async update(
    @Param('id') id: string,
    @Body() body: Partial<Meeting>,
  ): Promise<Meeting | { error: string }> {
    return await this.meetingsService.update(id, body);
  }

  @Delete(':id')
  async remove(@Param('id') id: string): Promise<Meeting | { error: string }> {
    return await this.meetingsService.remove(id);
  }
}
